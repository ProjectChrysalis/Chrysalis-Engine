/** Agent UI dev server: hot updates for client-agent/ against a running engine. */
import index from "../../client-agent/index.html";
import { serveFrontend } from "./serve.js";

serveFrontend({ html: index, port: Number(process.env.PORT ?? 5174), label: "agent" });
