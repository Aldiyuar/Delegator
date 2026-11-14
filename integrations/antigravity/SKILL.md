---
name: argon-reasoning
description: Use when the user asks to consult Hydrogen, Argon, AI Studio, DeepSeek, Qwen, GLM, or Delegator, or when facing complex architectural decisions, multi-file root-cause debugging after 2+ failed fix attempts, subtle race conditions, security audits, complex mathematical or algorithmic synthesis, reverse engineering, or 100k+ token cross-repository analysis via Delegator.
---

# Delegator: Direct Web Model & Gemini 4 Hydrogen Routing

## Overview

**Core principle:** Route complex reasoning, code review, mathematical synthesis, or explicit user requests ("попроси hydrogen / водород / аргон / ai studio", "спроси у квена / deepseek / glm") directly to the target model via **Delegator** (`ai-delegate.cmd`), inspect both `[THOUGHTS]` and `[RESPONSE]`, and empirically verify proposed changes locally.

## Invocation Commands

Always write the prompt to a UTF-8 file first (`$env:TEMP\dg-task.txt`) to avoid shell quoting issues:

### 1. Google AI Studio — Gemini 4 Hydrogen (быстрее Argon, до 1M токенов, file dock attachments, multi-turn sessions)
```powershell
& "C:\Users\Vadim\AppData\Local\Programs\Delegator\runtime\ai-delegate.cmd" hydrogen `
  -PromptFile "$env:TEMP\dg-task.txt" `
  -SessionId "<semantic-session-slug>" `
  -ContextFile "C:\abs\path\file1.ts;C:\abs\path\file2.ts" `
  -TimeoutSec 360
```
*(Also supports `argon`, `aistudio`, `-Model hydrogen` or `-Model aistudio`.)*

### 2. Targeting a Specific Web Model (Strict Mode)
When the user names a specific model, pass `-Model <name>` (or use the model name as the subcommand: `deepseek`, `qwen`, `glm`):
- **DeepSeek**:
  ```powershell
  & "C:\Users\Vadim\AppData\Local\Programs\Delegator\runtime\ai-delegate.cmd" ask -Model deepseek -PromptFile "$env:TEMP\dg-task.txt" -ContextFile "C:\abs\path\file1.ts"
  ```
- **Qwen 3.8 Max**:
  ```powershell
  & "C:\Users\Vadim\AppData\Local\Programs\Delegator\runtime\ai-delegate.cmd" ask -Model qwen -PromptFile "$env:TEMP\dg-task.txt" -ContextFile "C:\abs\path\file1.ts"
  ```
- **GLM 5.3 (Z.ai)**:
  ```powershell
  & "C:\Users\Vadim\AppData\Local\Programs\Delegator\runtime\ai-delegate.cmd" ask -Model glm -PromptFile "$env:TEMP\dg-task.txt" -ContextFile "C:\abs\path\file1.ts"
  ```

### 3. Auto Pool or Multi-Model Council (`boost`)
- **Auto (strongest ready web model)**:
  ```powershell
  & "C:\Users\Vadim\AppData\Local\Programs\Delegator\runtime\ai-delegate.cmd" assist -CallerModel "antigravity" -PromptFile "$env:TEMP\dg-task.txt"
  ```
- **Council (2 strongest web models in parallel + judge synthesis)**:
  ```powershell
  & "C:\Users\Vadim\AppData\Local\Programs\Delegator\runtime\ai-delegate.cmd" boost -PromptFile "$env:TEMP\dg-task.txt"
  ```

## Output & Strict Mode Behavior
- Every model outputs `[THOUGHTS]` followed by `[RESPONSE]` on stdout.
- **Do not output raw `[THOUGHTS]` to the user in chat.** Ingest and evaluate `[THOUGHTS]` internally to understand the model's calculation and reasoning steps, then present only the verified final answer/code to the user.
- Explicit model calls (`argon`, `-Model deepseek`, `-Model qwen`, `-Model glm`) run in **strict mode**: if the requested model is overloaded or unavailable, Delegator does **not** silently substitute another model—it exits with code `1` and writes the exact reason to stderr so you can inform the user immediately.
