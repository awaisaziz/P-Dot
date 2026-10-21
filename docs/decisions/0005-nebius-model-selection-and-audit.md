# 0005 — Nebius Model Selection, Benchmarks & Data Privacy (AI-01)

- **Status**: Accepted
- **Author**: Person C (AI Layer)
- **Date**: 2026-10-18
- **Context**: Resolves requirement **AI-01** (Confirm exact Nemotron ~30B model ID, price, tool-calling support, and Nebius data-retention terms) and establishes multi-model tiering within the $25 project budget.

---

## 1. Verified Model Discovery (AI-01)

Direct query against `https://api.tokenfactory.nebius.com/v1/models` verified the active models available on Nebius Token Factory:

| Parameter | Confirmed Value |
| :--- | :--- |
| **Exact Model ID** | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` |
| **Context Window** | 262,144 tokens (~256k context) |
| **Input Pricing** | **$0.00000006 / token** ($0.06 per 1,000,000 prompt tokens) |
| **Output Pricing** | **$0.00000024 / token** ($0.24 per 1,000,000 completion tokens) |
| **Tool Calling** | **Native OpenAI-compatible JSON Schema supported** (verified via live test) |
| **Reasoning Trace** | Model natively returns step-by-step reasoning tokens alongside structured tool invocations |

### Budget Runway Analysis ($25.00 Cap)
* At **$0.24 per 1M completion tokens**, a $25 budget provides **104,166,666 output tokens**.
* Assuming an average conversation turn consumes ~1,000 input tokens and ~300 output tokens:
  $$\text{Cost per turn} \approx (1,000 \times \$0.00000006) + (300 \times \$0.00000024) = \$0.00006 + \$0.000072 = \$0.000132$$
* **Total conversation capacity on $25 budget**: **~189,000 turns**.

---

## 2. Nebius Model Comparison Matrix

We evaluated the top candidates available in the Nebius Token Factory catalog for P-Dot:

| Model ID | Context | Input / 1M | Output / 1M | Pros | Cons | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`** | 256k | $0.06 | $0.24 | Extremely cost-effective; native tool calling; step-by-step reasoning trace; fast TTFT. | Requires strict delimiter prompt boundaries to prevent prompt leakage. | **Primary Default** (Assigned to Person C) |
| **`nvidia/Nemotron-3_5-Lightning`** | 1,000k | $0.06 | $0.24 | Massive 1M token context; same low price; excels at long document recall. | Slightly higher latency on short chat replies than Nano. | **Document RAG Specialist** (AI-05) |
| **`Qwen/Qwen3-30B-A3B-Instruct-2507`** | 256k | $0.10 | $0.30 | Strong multilingual and structured coding capabilities. | Higher cost ($0.30/1M); function calling can occasionally be verbose. | **Secondary Fallback** |
| **`google/gemma-3-27b-it`** | 110k | $0.10 | $0.30 | Excellent instruction following; compact context format. | Smaller context (110k); higher cost per token. | Alternative candidate |
| **`deepseek-ai/DeepSeek-V4-Flash-0731`** | 1,000k | $0.14 | $0.28 | Very fast response times; strong mathematical reasoning. | Slightly higher prompt pricing than Nemotron. | High-speed alternative |
| **`Qwen/Qwen3-Embedding-8B`** | 40k | $0.01 | $0.00 | Ultra-cheap text embeddings for document indexing ($0.01/1M). | Embedding only (no text generation). | **Selected for Vector Embeddings** (AI-05) |

---

## 3. Tool-Calling Verification (Live Benchmark)

The model was tested against an OpenAI-compatible function calling payload:
```json
{
  "model": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  "messages": [{ "role": "user", "content": "What is the weather in Tokyo right now?" }],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get real-time weather for a city",
      "parameters": {
        "type": "object",
        "properties": { "location": { "type": "string" } },
        "required": ["location"]
      }
    }
  }],
  "tool_choice": "auto"
}
```

### Result:
* **HTTP Status**: `200 OK`
* **Finish Reason**: `tool_calls`
* **Tool Call Emitted**:
  ```json
  {
    "id": "chatcmpl-tool-99372708ace9fdd5",
    "type": "function",
    "function": {
      "name": "get_weather",
      "arguments": "{\"location\": \"Tokyo\"}"
    }
  }
  ```
* **Status**: **PASSED**. The model accurately extracted the argument without prompting or hallucinating.

---

## 4. Nebius Data Retention & Privacy Terms (AI-01)

Directly sourced from the official [Nebius Legal & Privacy Guide](https://docs.tokenfactory.nebius.com/legal/legal-quick-guide.md):

1. **No Model Training**: Nebius contractually guarantees that **customer prompts and completions are never used to train, fine-tune, or improve any AI models** (neither Nebius models nor third-party models).
2. **Default Processing**: Requests are processed on public serverless infrastructure. In-flight prompts and completions are temporarily cached in EU data centers (Finland) solely for **Speculative Decoding** token acceleration.
3. **Zero Data Retention (ZDR)**: Customers can toggle **Zero Data Retention** in the Nebius Account Profile. When enabled:
   * No inputs or outputs are stored anywhere on disk after the request is finished.
   * Ephemeral in-memory processing only.
4. **Data Ownership**: The developer/customer retains 100% intellectual property ownership of all input prompts and generated output.
5. **Certifications**: Fully GDPR compliant; certified under **ISO 27001**, **ISO 27701**, and **SOC 2 Type II**.

---

## 5. Implementation Changes

1. Updated `.env.local` setting:
   ```env
   NEBIUS_MODEL=nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B
   ```
2. Validated and confirmed API reachability for Nebius and Tavily.

---

## 6. Frontier Tier: Best Model Picks (Unconstrained Budget)

If project funding or enterprise deployment removes the $25 budget constraint, the following frontier-class models on Nebius represent the state-of-the-art for multi-agent personal assistants:

| Model ID | Architecture / Size | Context | Input / 1M | Output / 1M | Why It's a Top Frontier Pick | Tradeoffs |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`nvidia/Nemotron-3-Ultra-550b-a55b`** | 550B MoE (55B active) | **1,000k (1M)** | $1.00 | $3.00 | NVIDIA's flagship reasoning beast. Incredible multi-step planning, high semantic comprehension, and flawless tool execution across deep conversation histories. | High completion cost ($3.00/1M); slower TTFT on long prompts. |
| **`NousResearch/Hermes-4-405B`** | 405B Dense | **131k** | $1.00 | $3.00 | The largest open-weights dense model in the world, specifically fine-tuned by Nous Research for **agentic workflows, function calling, and structured JSON schemas**. | 131k context window is smaller than 1M models. |
| **`deepseek-ai/DeepSeek-V4-Pro`** | Frontier Reasoning MoE | **1,000k (1M)** | $1.75 | $3.50 | World-class mathematical, logical, and code-synthesis reasoning. Exceptional zero-shot planning for complex agent tools. | Cost ($3.50/1M output); requires strict rate-limit management. |
| **`Qwen/Qwen3.5-397B-A17B`** | 397B MoE (17B active) | **262k** | $0.60 | $3.60 | Exceptional multi-lingual knowledge, complex structured reasoning, and high factual recall across research and planning domains. | Higher output token pricing. |
| **`moonshotai/Kimi-K3`** | Long-context Frontier | **1,024k (1M)** | $3.00 | $15.00 | Ultra-deep document synthesis, nuance extraction, and literary writing quality across million-token inputs. | Premium pricing ($15.00/1M output); best reserved for intensive deep-research reports. |

### When to Upgrade from Nano (30B) to Ultra (550B / 405B):
* **Phase 1 (MVP & Tool Development)**: Stick with **`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`** ($0.06 / $0.24). It provides fast feedback, costs fractions of a cent, and already passes tool-calling tests.
* **Phase 2 (Complex Autonomous Workflows - AI-09 & AI-10)**: When P-Dot needs to handle multi-step planning (e.g., cross-referencing multiple calendars, reading documents, drafting emails, and synthesizing web search results in a single turn), switch to **`nvidia/Nemotron-3-Ultra-550b-a55b`** or **`NousResearch/Hermes-4-405B`**.

