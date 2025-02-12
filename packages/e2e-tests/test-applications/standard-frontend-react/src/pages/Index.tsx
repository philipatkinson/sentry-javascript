import * as React from 'react';
import * as Sentry from '@sentry/react';
import { Link } from 'react-router-dom';

const Index = () => {
  return (
    <>
      <input
        type="button"
        value="Capture Exception"
        id="exception-button"
        onClick={() => {
          const eventId = Sentry.captureException(new Error('I am an error!'));
          // @ts-ignore
          window.capturedExceptionId = eventId;
        }}
      />
      <Link to="/user/5" id="navigation">
        navigate
      </Link>
    </>
  );
};

export default Index;
