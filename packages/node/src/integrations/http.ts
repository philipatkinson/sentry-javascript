import { getCurrentHub, Hub } from '@sentry/core';
import { EventProcessor, Integration, Span, TracePropagationTargets } from '@sentry/types';
import {
  dynamicSamplingContextToSentryBaggageHeader,
  fill,
  isMatchingPattern,
  logger,
  parseSemver,
} from '@sentry/utils';
import * as http from 'http';
import * as https from 'https';

import { NodeClientOptions } from '../types';
import {
  cleanSpanDescription,
  extractUrl,
  isSentryRequest,
  normalizeRequestArgs,
  RequestMethod,
  RequestMethodArgs,
} from './utils/http';

const NODE_VERSION = parseSemver(process.versions.node);

/**
 * The http module integration instruments Node's internal http module. It creates breadcrumbs, transactions for outgoing
 * http requests and attaches trace data when tracing is enabled via its `tracing` option.
 */
export class Http implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'Http';

  /**
   * @inheritDoc
   */
  public name: string = Http.id;

  /**
   * @inheritDoc
   */
  private readonly _breadcrumbs: boolean;

  /**
   * @inheritDoc
   */
  private readonly _tracing: boolean;

  /**
   * @inheritDoc
   */
  public constructor(options: { breadcrumbs?: boolean; tracing?: boolean } = {}) {
    this._breadcrumbs = typeof options.breadcrumbs === 'undefined' ? true : options.breadcrumbs;
    this._tracing = typeof options.tracing === 'undefined' ? false : options.tracing;
  }

  /**
   * @inheritDoc
   */
  public setupOnce(
    _addGlobalEventProcessor: (callback: EventProcessor) => void,
    setupOnceGetCurrentHub: () => Hub,
  ): void {
    // No need to instrument if we don't want to track anything
    if (!this._breadcrumbs && !this._tracing) {
      return;
    }

    const clientOptions = setupOnceGetCurrentHub().getClient()?.getOptions() as NodeClientOptions | undefined;

    const wrappedHandlerMaker = _createWrappedRequestMethodFactory(
      this._breadcrumbs,
      this._tracing,
      clientOptions?.tracePropagationTargets,
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const httpModule = require('http');
    fill(httpModule, 'get', wrappedHandlerMaker);
    fill(httpModule, 'request', wrappedHandlerMaker);

    // NOTE: Prior to Node 9, `https` used internals of `http` module, thus we don't patch it.
    // If we do, we'd get double breadcrumbs and double spans for `https` calls.
    // It has been changed in Node 9, so for all versions equal and above, we patch `https` separately.
    if (NODE_VERSION.major && NODE_VERSION.major > 8) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const httpsModule = require('https');
      fill(httpsModule, 'get', wrappedHandlerMaker);
      fill(httpsModule, 'request', wrappedHandlerMaker);
    }
  }
}

// for ease of reading below
type OriginalRequestMethod = RequestMethod;
type WrappedRequestMethod = RequestMethod;
type WrappedRequestMethodFactory = (original: OriginalRequestMethod) => WrappedRequestMethod;

/**
 * Function which creates a function which creates wrapped versions of internal `request` and `get` calls within `http`
 * and `https` modules. (NB: Not a typo - this is a creator^2!)
 *
 * @param breadcrumbsEnabled Whether or not to record outgoing requests as breadcrumbs
 * @param tracingEnabled Whether or not to record outgoing requests as tracing spans
 *
 * @returns A function which accepts the exiting handler and returns a wrapped handler
 */
function _createWrappedRequestMethodFactory(
  breadcrumbsEnabled: boolean,
  tracingEnabled: boolean,
  tracePropagationTargets: TracePropagationTargets | undefined,
): WrappedRequestMethodFactory {
  // We're caching results so we dont have to recompute regexp everytime we create a request.
  const urlMap: Record<string, boolean> = {};
  const shouldAttachTraceData = (url: string): boolean => {
    if (tracePropagationTargets === undefined) {
      return true;
    }

    if (urlMap[url]) {
      return urlMap[url];
    }

    urlMap[url] = tracePropagationTargets.some(tracePropagationTarget =>
      isMatchingPattern(url, tracePropagationTarget),
    );

    return urlMap[url];
  };

  return function wrappedRequestMethodFactory(originalRequestMethod: OriginalRequestMethod): WrappedRequestMethod {
    return function wrappedMethod(this: typeof http | typeof https, ...args: RequestMethodArgs): http.ClientRequest {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const httpModule = this;

      const requestArgs = normalizeRequestArgs(this, args);
      const requestOptions = requestArgs[0];
      const requestUrl = extractUrl(requestOptions);

      // we don't want to record requests to Sentry as either breadcrumbs or spans, so just use the original method
      if (isSentryRequest(requestUrl)) {
        return originalRequestMethod.apply(httpModule, requestArgs);
      }

      let requestSpan: Span | undefined;
      let parentSpan: Span | undefined;

      const scope = getCurrentHub().getScope();

      if (scope && tracingEnabled) {
        parentSpan = scope.getSpan();

        if (parentSpan) {
          requestSpan = parentSpan.startChild({
            description: `${requestOptions.method || 'GET'} ${requestUrl}`,
            op: 'http.client',
          });

          if (shouldAttachTraceData(requestUrl)) {
            const sentryTraceHeader = requestSpan.toTraceparent();
            __DEBUG_BUILD__ &&
              logger.log(
                `[Tracing] Adding sentry-trace header ${sentryTraceHeader} to outgoing request to "${requestUrl}": `,
              );

            requestOptions.headers = {
              ...requestOptions.headers,
              'sentry-trace': sentryTraceHeader,
            };

            if (parentSpan.transaction) {
              const dynamicSamplingContext = parentSpan.transaction.getDynamicSamplingContext();
              const sentryBaggageHeader = dynamicSamplingContextToSentryBaggageHeader(dynamicSamplingContext);

              let newBaggageHeaderField;
              if (!requestOptions.headers || !requestOptions.headers.baggage) {
                newBaggageHeaderField = sentryBaggageHeader;
              } else if (!sentryBaggageHeader) {
                newBaggageHeaderField = requestOptions.headers.baggage;
              } else if (Array.isArray(requestOptions.headers.baggage)) {
                newBaggageHeaderField = [...requestOptions.headers.baggage, sentryBaggageHeader];
              } else {
                // Type-cast explanation:
                // Technically this the following could be of type `(number | string)[]` but for the sake of simplicity
                // we say this is undefined behaviour, since it would not be baggage spec conform if the user did this.
                newBaggageHeaderField = [requestOptions.headers.baggage, sentryBaggageHeader] as string[];
              }

              requestOptions.headers = {
                ...requestOptions.headers,
                // Setting a hader to `undefined` will crash in node so we only set the baggage header when it's defined
                ...(newBaggageHeaderField && { baggage: newBaggageHeaderField }),
              };
            }
          } else {
            __DEBUG_BUILD__ &&
              logger.log(
                `[Tracing] Not adding sentry-trace header to outgoing request (${requestUrl}) due to mismatching tracePropagationTargets option.`,
              );
          }

          const transaction = parentSpan.transaction;
          if (transaction) {
            transaction.metadata.propagations += 1;
          }
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      return originalRequestMethod
        .apply(httpModule, requestArgs)
        .once('response', function (this: http.ClientRequest, res: http.IncomingMessage): void {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          const req = this;
          if (breadcrumbsEnabled) {
            addRequestBreadcrumb('response', requestUrl, req, res);
          }
          if (tracingEnabled && requestSpan) {
            if (res.statusCode) {
              requestSpan.setHttpStatus(res.statusCode);
            }
            requestSpan.description = cleanSpanDescription(requestSpan.description, requestOptions, req);
            requestSpan.finish();
          }
        })
        .once('error', function (this: http.ClientRequest): void {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          const req = this;

          if (breadcrumbsEnabled) {
            addRequestBreadcrumb('error', requestUrl, req);
          }
          if (tracingEnabled && requestSpan) {
            requestSpan.setHttpStatus(500);
            requestSpan.description = cleanSpanDescription(requestSpan.description, requestOptions, req);
            requestSpan.finish();
          }
        });
    };
  };
}

/**
 * Captures Breadcrumb based on provided request/response pair
 */
function addRequestBreadcrumb(event: string, url: string, req: http.ClientRequest, res?: http.IncomingMessage): void {
  if (!getCurrentHub().getIntegration(Http)) {
    return;
  }

  getCurrentHub().addBreadcrumb(
    {
      category: 'http',
      data: {
        method: req.method,
        status_code: res && res.statusCode,
        url,
      },
      type: 'http',
    },
    {
      event,
      request: req,
      response: res,
    },
  );
}
