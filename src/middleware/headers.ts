import helmet from "helmet";

export const helmetHeaders = helmet({
  contentSecurityPolicy: false,
});
