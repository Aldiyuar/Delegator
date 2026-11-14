#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { ArgonEngine } = require('./engine.js');

async function main() {
  const args = process.argv.slice(2);
  let prompt = '';
  let outputFile = null;
  let promptId = null;
  const fileAttachments = [];
  let timeoutMs = 360000;

  const positional = [];
  let promptFromFile = null;
  let systemInstruction = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--prompt-file' && next) {
      promptFromFile = fs.readFileSync(path.resolve(next), 'utf-8');
      i++;
    } else if ((arg === '--system' || arg === '--system-instruction') && next) {
      systemInstruction = next;
      i++;
    } else if (arg === '--file' && next) {
      fileAttachments.push(path.resolve(next));
      i++;
    } else if ((arg === '--out' || arg === '--output') && next) {
      outputFile = path.resolve(next);
      i++;
    } else if ((arg === '--prompt-id' || arg === '--project' || arg === '--session' || arg === '--session-id') && next) {
      promptId = next;
      i++;
    } else if ((arg === '--image' || arg === '--file-attach' || arg === '--attach') && next) {
      fileAttachments.push(path.resolve(next));
      i++;
    } else if (arg === '--files' && next) {
      const parts = next.split(',').map(s => s.trim()).filter(Boolean);
      for (const p of parts) fileAttachments.push(path.resolve(p));
      i++;
    } else if (arg === '--timeout' && next) {
      timeoutMs = (parseInt(next, 10) || 360) * 1000;
      i++;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (promptFromFile) {
    prompt = promptFromFile;
  } else if (positional.length > 0) {
    prompt = positional.join(' ');
  } else if (fileAttachments.length === 1 && args.includes('--file') && !args.includes('--attach') && !args.includes('--file-attach')) {
    // Backward compatibility: if executed strictly as `ask-argon-cli.js --file prompt.txt` without prompt text
    prompt = fs.readFileSync(fileAttachments.pop(), 'utf-8');
  }

  if (!prompt) {
    prompt = 'Привет, Аргон! Расскажи о себе.';
  }

  const promptPreview = prompt.length > 200 
    ? `(Входной текст/файл на ${prompt.length} символов)` 
    : `"${prompt}"`;
  console.error(`\n[Запрос к Gemini 4 Hydrogen]: ${promptPreview}`);
  if (promptId) {
    console.error(`[Контекст / Чат ID]: "${promptId}"`);
  }
  if (fileAttachments.length > 0) {
    console.error(`[Вложения (${fileAttachments.length})]:\n${fileAttachments.map(f => `  - ${f}`).join('\n')}`);
  }
  console.error('');

  const engine = new ArgonEngine();

  const cleanupAndExit = async (code = 130) => {
    try {
      engine.ipcLock.release();
      await new Promise(r => setTimeout(r, 350));
      const anotherProcessWaiting = engine.ipcLock.isLocked();
      await engine.shutdown({ keepHostAlive: engine.isExternalBrowser || anotherProcessWaiting });
    } catch (_) {}
    process.exit(code);
  };

  process.once('SIGINT', () => cleanupAndExit(130));
  process.once('SIGTERM', () => cleanupAndExit(143));

  try {
    const result = await engine.askArgon({ 
      prompt, 
      systemInstruction,
      sessionId: promptId,
      promptId, 
      images: fileAttachments,
      timeoutMs 
    });
    const thoughts = typeof result === 'object' ? result.thoughts : '';
    const response = typeof result === 'object' ? result.response : result;
    const formattedOutput = thoughts
      ? `[THOUGHTS]\n${thoughts}\n\n[RESPONSE]\n${response}`
      : `[RESPONSE]\n${String(response || '')}`;

    if (outputFile) {
      fs.writeFileSync(outputFile, formattedOutput, 'utf-8');
      console.error(`[ArgonCLI] Результат успешно сохранён в: ${outputFile} (${formattedOutput.length} символов)`);
    } else {
      await new Promise((resolve) => {
        const flushed = process.stdout.write(formattedOutput + '\n', 'utf-8');
        if (flushed) {
          resolve();
        } else {
          process.stdout.once('drain', resolve);
        }
      });
    }

    if (result && (result.promptUrl || result.promptId)) {
      console.error(`[ArgonCLI] Чат зафиксирован в Google AI Studio: ${result.promptUrl || `https://aistudio.google.com/prompts/${result.promptId}`}`);
    }
  } catch (err) {
    console.error('Ошибка:', err.message);
    process.exitCode = 1;
  } finally {
    // Если браузер был запущен нами как хост, но другой процесс (например, MCP-сервер или параллельный вызов)
    // уже ожидает лок в цикле, даем паузу 350мс, чтобы ожидающий процесс проснулся и успел захватить блокировку.
    let anotherProcessWaiting = false;
    try {
      await new Promise(r => setTimeout(r, 350));
      anotherProcessWaiting = engine.ipcLock.isLocked();
    } catch (_) {}
    await engine.shutdown({ keepHostAlive: engine.isExternalBrowser || anotherProcessWaiting });
    process.exit(process.exitCode || 0);
  }
}

main();
