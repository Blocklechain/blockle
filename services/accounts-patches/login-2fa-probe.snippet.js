       * AN ABSENT CODE IS A QUESTION, NOT A GUESS.
       *
       * A client that does not yet know this account has 2FA posts the
       * password alone; this response is the only way it can find out.
       * Counting that as a failed attempt meant every 2FA sign-in burned one
       * against the lockout BEFORE the person had been asked for a code, so a
       * couple of typos reached the threshold of four and the exponential
       * backoff engaged within seconds.
       *
       * It leaks nothing: reaching this line already required the correct
       * password, and the 401 is what reveals 2FA is enabled either way. A
       * WRONG code is still recorded, which is the case that matters.
       */
      if (code === '') {
        return json(res, 401, { error: '2fa', message: 'Enter your 6-digit code.' });
      }
      const recoveryOk = await tryRecovery(u, code);
      if (!totpVerify(u.totpSecret, code, now()) && !recoveryOk)
        { acctRl.recordFailure(acctKey); return json(res, 401, { error: '2fa', message: 'That code was not accepted. Wait for the next one, or use a recovery code.' }); }
    }
