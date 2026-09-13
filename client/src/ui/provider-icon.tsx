import type { ComponentPropsWithoutRef } from "react"
import { HardDrives } from "@phosphor-icons/react"
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg"
import bedrock from "@lobehub/icons-static-svg/icons/bedrock.svg"
import antgroup from "@lobehub/icons-static-svg/icons/antgroup.svg"
import google from "@lobehub/icons-static-svg/icons/google.svg"
import googlecloud from "@lobehub/icons-static-svg/icons/googlecloud.svg"
import openai from "@lobehub/icons-static-svg/icons/openai.svg"
import azure from "@lobehub/icons-static-svg/icons/azure.svg"
import nvidia from "@lobehub/icons-static-svg/icons/nvidia.svg"
import deepseek from "@lobehub/icons-static-svg/icons/deepseek.svg"
import copilot from "@lobehub/icons-static-svg/icons/copilot.svg"
import groq from "@lobehub/icons-static-svg/icons/groq.svg"
import cerebras from "@lobehub/icons-static-svg/icons/cerebras.svg"
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg"
import vercel from "@lobehub/icons-static-svg/icons/vercel.svg"
import zai from "@lobehub/icons-static-svg/icons/zai.svg"
import mistral from "@lobehub/icons-static-svg/icons/mistral.svg"
import minimax from "@lobehub/icons-static-svg/icons/minimax.svg"
import moonshot from "@lobehub/icons-static-svg/icons/moonshot.svg"
import huggingface from "@lobehub/icons-static-svg/icons/huggingface.svg"
import fireworks from "@lobehub/icons-static-svg/icons/fireworks.svg"
import together from "@lobehub/icons-static-svg/icons/together.svg"
import baseten from "@lobehub/icons-static-svg/icons/baseten.svg"
import kimi from "@lobehub/icons-static-svg/icons/kimi.svg"
import cloudflare from "@lobehub/icons-static-svg/icons/cloudflare.svg"
import qwen from "@lobehub/icons-static-svg/icons/qwen.svg"
import xiaomimimo from "@lobehub/icons-static-svg/icons/xiaomimimo.svg"
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg"
import xai from "@lobehub/icons-static-svg/icons/xai.svg"
import ollama from "@lobehub/icons-static-svg/icons/ollama.svg"
import lmstudio from "@lobehub/icons-static-svg/icons/lmstudio.svg"
import vllm from "@lobehub/icons-static-svg/icons/vllm.svg"
import deepinfra from "@lobehub/icons-static-svg/icons/deepinfra.svg"
import novita from "@lobehub/icons-static-svg/icons/novita.svg"
import venice from "@lobehub/icons-static-svg/icons/venice.svg"
import zenmux from "@lobehub/icons-static-svg/icons/zenmux.svg"
import cohere from "@lobehub/icons-static-svg/icons/cohere.svg"
import cometapi from "@lobehub/icons-static-svg/icons/cometapi.svg"
import featherless from "@lobehub/icons-static-svg/icons/featherless.svg"
import infermatic from "@lobehub/icons-static-svg/icons/infermatic.svg"
import perplexity from "@lobehub/icons-static-svg/icons/perplexity.svg"
import siliconcloud from "@lobehub/icons-static-svg/icons/siliconcloud.svg"
import nanogpt from "./logos/nanogpt.svg"
import koboldcpp from "./logos/koboldcpp.svg"
import llamacpp from "./logos/llamacpp.svg"
import tabby from "./logos/tabby.svg"

const logos: Record<string, string> = {
  "amazon-bedrock": bedrock,
  "ant-ling": antgroup,
  "anthropic": anthropic,
  "google": google,
  "google-vertex": googlecloud,
  "openai": openai,
  "azure-openai-responses": azure,
  "openai-codex": openai,
  "nvidia": nvidia,
  "deepseek": deepseek,
  "github-copilot": copilot,
  "xai": xai,
  "groq": groq,
  "cerebras": cerebras,
  "openrouter": openrouter,
  "vercel-ai-gateway": vercel,
  "zai": zai,
  "zai-coding-cn": zai,
  "mistral": mistral,
  "minimax": minimax,
  "minimax-cn": minimax,
  "moonshotai": moonshot,
  "moonshotai-cn": moonshot,
  "huggingface": huggingface,
  "fireworks": fireworks,
  "together": together,
  "baseten": baseten,
  "opencode": opencode,
  "opencode-go": opencode,
  "kimi-coding": kimi,
  "cloudflare-workers-ai": cloudflare,
  "cloudflare-ai-gateway": cloudflare,
  "qwen-token-plan": qwen,
  "qwen-token-plan-cn": qwen,
  "qwen-token-plan-individual": qwen,
  "xiaomi": xiaomimimo,
  "xiaomi-token-plan-cn": xiaomimimo,
  "xiaomi-token-plan-ams": xiaomimimo,
  "xiaomi-token-plan-sgp": xiaomimimo,
  "nanogpt": nanogpt,
  "nanogpt-subscription": nanogpt,
  "deepinfra": deepinfra,
  "novita": novita,
  "venice": venice,
  "zenmux": zenmux,
  "ollama-cloud": ollama,
  "cohere": cohere,
  "cometapi": cometapi,
  "featherless": featherless,
  "infermatic": infermatic,
  "perplexity": perplexity,
  "siliconflow": siliconcloud,
  "siliconflow-cn": siliconcloud,
  "__local_koboldcpp": koboldcpp,
  "__local_llamacpp": llamacpp,
  "__local_ollama": ollama,
  "__local_lmstudio": lmstudio,
  "__local_tabbyapi": tabby,
  "__local_vllm": vllm,
}

export function ProviderIcon({ id, className, ...rest }: ComponentPropsWithoutRef<"span"> & { id: string }) {
  const logo = logos[id.replace(/^oauth_/, "")]
  return (
    <span data-component="provider-icon" className={className} aria-hidden="true" {...rest}>
      {logo ? (
        <span className="provider-logo" style={{ maskImage: `url("${logo}")` }} />
      ) : (
        <HardDrives className="size-full" />
      )}
    </span>
  )
}
