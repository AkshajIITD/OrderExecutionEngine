import "dotenv/config";
import { buildApp } from "./app.js";

const app = await buildApp();

app.ready().then(() => app.printRoutes());
app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });