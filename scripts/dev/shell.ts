/** Shell dev server: hot updates for client/ against a running engine. */
import index from "../../client/index.html";
import { serveFrontend } from "./serve.js";

serveFrontend({ html: index, port: Number(process.env.PORT ?? 5173), label: "shell" });
