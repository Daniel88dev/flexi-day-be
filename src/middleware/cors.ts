import cors from "cors";

export const serverCors = cors({
  origin: "http://localhost:8080", //TODO: replace with production url
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
});
