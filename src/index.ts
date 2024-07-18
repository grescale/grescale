import express, { Express, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import dotenv from "dotenv";
import cors from "cors";
import { json, urlencoded } from "body-parser";
import cookieParser from "cookie-parser";

dotenv.config();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes).
  standardHeaders: "draft-7", // draft-6: `RateLimit-*` headers; draft-7: combined `RateLimit` header
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers.
  // store: ... , // Redis, Memcached, etc. See below.
});

const app: Express = express();
const port = process.env.PORT || 5000;

// Apply the rate limiting middleware to all requests.
app.use(limiter);
app.use(cors());
app.use(cookieParser());
app.use(urlencoded({ extended: true }));
app.use(json());

app.get("/health", (req: Request, res: Response) => {
  res.send("Grescale is running!");
});

app.listen(port, () => {
  console.log(`[server]: Server is running at http://localhost:${port}`);
});
