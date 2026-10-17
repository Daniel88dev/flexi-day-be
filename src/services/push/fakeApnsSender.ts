import type { pushEnvironment } from "../../db/schema/push-registration-schema.js";
import type { ApnsAnswer, ApnsPush, ApnsSender } from "./types.js";

/** `"hang"` never answers, so only the caller's timeout ends the send. */
export type FakeApnsAnswer = ApnsAnswer | "hang";

export type FakeApnsSender = ApnsSender & {
  sends: Omit<ApnsPush, "signal">[];
  answer(environment: pushEnvironment, answer: FakeApnsAnswer): void;
  reset(): void;
};

/** Records pushes for e2e tests and answers as told, standing in for both APNs hosts. */
export function createFakeApnsSender(): FakeApnsSender {
  const answers = new Map<pushEnvironment, FakeApnsAnswer>();
  const sends: FakeApnsSender["sends"] = [];

  return {
    sends,
    answer: (environment, answer) => answers.set(environment, answer),
    reset: () => {
      sends.length = 0;
      answers.clear();
    },
    send: ({ signal, ...push }) => {
      sends.push(push);
      const answer = answers.get(push.environment) ?? { status: 200 };
      if (answer !== "hang") return Promise.resolve(answer);
      return new Promise<ApnsAnswer>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      });
    },
  };
}
