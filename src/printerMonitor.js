export function createPrinterMonitorTracker(failureThreshold = 3) {
  const threshold = Math.max(1, Number.parseInt(failureThreshold, 10) || 3);
  let consecutiveFailures = 0;
  let notifiedProblemKey = '';

  return {
    record(hardProblems) {
      const problems = Array.from(new Set(hardProblems)).sort();
      const problemKey = problems.join('|');

      if (problems.length === 0) {
        consecutiveFailures = 0;
        if (!notifiedProblemKey) {
          return { type: 'none', consecutiveFailures };
        }

        notifiedProblemKey = '';
        return { type: 'recovered', consecutiveFailures };
      }

      consecutiveFailures += 1;
      if (consecutiveFailures < threshold || problemKey === notifiedProblemKey) {
        return { type: 'none', consecutiveFailures };
      }

      notifiedProblemKey = problemKey;
      return {
        type: 'problem',
        problems,
        consecutiveFailures
      };
    },

    get consecutiveFailures() {
      return consecutiveFailures;
    }
  };
}

export function shouldPausePrinterMonitor({
  queuedPrintCount,
  pausedUntil,
  now = Date.now()
}) {
  return queuedPrintCount > 0 || now < pausedUntil;
}
