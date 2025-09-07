import helmet from "helmet";

export const helmetHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      //fontSrc: ["'self'", "https://fonts.google.com"],
    },
  },
});
