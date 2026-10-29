import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";

// Standalone builds cannot resolve provider modules from the filesystem.
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
