# Antigravity 2.0 Integration Directives for Delegator

Add the following section to your `~/.gemini/GEMINI.md` to enable autonomous auto-delegation, Hydrogen-first priority routing, and strict mode model routing:

```markdown
<mcp_and_skills_orchestration>
DELEGATOR DIRECT MODEL ROUTING & AUTONOMOUS DELEGATION:
- **Autonomous Auto-Delegation (Hydrogen Priority & Automatic Fallback)**:
  * Antigravity proactively delegates tasks to Delegator (`ai-delegate.cmd assist` or `boost`) in the following cases:
    - Complex architectural decisions, multi-component planning, or heavy refactoring touching >3 interrelated files.
    - Tricky mathematical or algorithmic synthesis, subtle race conditions, concurrency bugs, or low-level systems/hooking/reverse-engineering.
    - Deep multi-file root-cause debugging after 2 failed local fix attempts.
    - Large context or heavy log analysis (>15,000 characters or multiple repository source files) — always pass them via `-ContextFile "path1;path2"`.
  * **Hydrogen-First Policy**: All general calls (`assist`) prioritize **Gemini 4 Hydrogen (Google AI Studio)** by default. Forwarding to secondary models (GLM 5.3, Qwen 3.8 Max, DeepSeek) occurs automatically ONLY if Hydrogen times out, hits a quota limit, or fails to respond.
- **Cognitive Ingestion of `[THOUGHTS]`**:
  * Delegator exports both `[THOUGHTS]` and `[RESPONSE]` across all web models (Google AI Studio / Gemini 4 Hydrogen, DeepSeek, Qwen 3.8 Max, GLM 5.3).
  * Absorb `[THOUGHTS]` strictly into internal context to understand the external model's thought process, verify invariants, and validate correctness.
  * **NEVER output the raw `[THOUGHTS]` block to the user in chat.** Present only the clean, verified technical explanation and final implementation.
- **Explicit User Directives (Strict Mode)**:
  * When the user explicitly asks for a specific model ("ask hydrogen", "ask deepseek", "ask qwen", "ask glm", "run council/boost"), write the prompt to a UTF-8 file (`$env:TEMP\dg-task.txt`) and invoke:
    * **Gemini 4 Hydrogen (AI Studio)**:
      `& "$env:LOCALAPPDATA\Programs\Delegator\runtime\ai-delegate.cmd" hydrogen -PromptFile "$env:TEMP\dg-task.txt" -ContextFile "C:\path\file1;C:\path\file2"`
    * **DeepSeek**:
      `& "$env:LOCALAPPDATA\Programs\Delegator\runtime\ai-delegate.cmd" ask -Model deepseek -PromptFile "$env:TEMP\dg-task.txt" -ContextFile "C:\path\file1"`
    * **Qwen 4 Max Preview**:
      `& "$env:LOCALAPPDATA\Programs\Delegator\runtime\ai-delegate.cmd" ask -Model qwen -PromptFile "$env:TEMP\dg-task.txt" -ContextFile "C:\path\file1"`
    * **GLM 5.3 (Z.ai)**:
      `& "$env:LOCALAPPDATA\Programs\Delegator\runtime\ai-delegate.cmd" ask -Model glm -PromptFile "$env:TEMP\dg-task.txt" -ContextFile "C:\path\file1"`
    * **Auto Pool (Hydrogen-first with automatic fallback to GLM 5.3, Qwen 4 Max, DeepSeek)**:
      `& "$env:LOCALAPPDATA\Programs\Delegator\runtime\ai-delegate.cmd" assist -CallerModel "antigravity" -PromptFile "$env:TEMP\dg-task.txt"`
</mcp_and_skills_orchestration>
```
