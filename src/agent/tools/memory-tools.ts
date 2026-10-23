/** Agent-local tools (risk 0): they change only this assistant's own memory, never Liara. */
import { z } from 'zod';
import { appNameSchema, ok } from '../../tools/helpers';
import { defineTool } from '../../tools/registry';
import { addUserNote, getMemoryKey, setMemoryKey } from '../memory';

export const setAppWatchTool = defineTool({
  name: 'set_app_watch',
  title: 'Turn monitoring on/off',
  description:
    "Turn this assistant's background monitoring for an app on or off (health, memory, crash events every minute; proactive alerts). Changes nothing on Liara.",
  input: z.object({ appName: appNameSchema, on: z.boolean() }),
  risk: 0,
  writesLocal: true,
  category: 'ops',
  describeFa: ({ appName, on }) => (on ? `روشن کردن پایش خودکار ${appName}` : `خاموش کردن پایش خودکار ${appName}`),
  run: async ({ appName, on }, ctx) => {
    setMemoryKey(ctx.db, appName, 'watch', on, ctx.now());
    return ok({ appName, watch: on }, on ? `پایش خودکار ${appName} روشن شد؛ اگر مشکلی پیش بیاید خبرتان می‌کنم.` : `پایش خودکار ${appName} خاموش شد.`);
  },
});

export const saveAppNoteTool = defineTool({
  name: 'save_app_note',
  title: 'Remember a note about an app',
  description: 'Store a short fact the user asked you to remember about an app (e.g. "high traffic at night"). It is shown back in future conversations.',
  input: z.object({ appName: appNameSchema, note: z.string().min(2).max(300) }),
  risk: 0,
  writesLocal: true,
  category: 'ops',
  describeFa: ({ appName }) => `به خاطر سپردن یک نکته درباره‌ی ${appName}`,
  run: async ({ appName, note }, ctx) => {
    const notes = addUserNote(ctx.db, appName, note, ctx.now());
    return ok({ appName, notes: notes.length, watch: getMemoryKey(ctx.db, appName, 'watch') }, 'به خاطر سپردم.');
  },
});

export const memoryTools = [setAppWatchTool, saveAppNoteTool];
