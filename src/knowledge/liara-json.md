# فایل liara.json

فایل تنظیمات پروژه برای لیارا در ریشه‌ی پروژه. این فایل خودش آپلود نمی‌شود؛ مقدارهایش هنگام انتشار خوانده می‌شوند.

## کلیدهای اصلی

- `app`: نام برنامه در لیارا (حروف کوچک، عدد و خط تیره).
- `platform`: یکی از `node`, `next`, `react`, `vue`, `angular`, `static`, `laravel`, `php`, `django`, `flask`, `python`, `dotnet`, `go`, `docker`.
- `port`: پورتی که برنامه روی آن گوش می‌دهد.
- `build`: تنظیمات ساخت مثل `{"cache": true, "args": [...], "dockerfile": "..."}`.
- `healthCheck`: بررسی سلامت سفارشی با `command`.
- `cron`: فهرست کارهای زمان‌بندی‌شده.
- `disks`: اتصال دیسک ماندگار به یک مسیر (`[{"name": "uploads", "mountTo": "/app/uploads"}]`).
- `args`: آرگومان‌های اجرای برنامه.

## تنظیم نسخه‌ی زبان

- Node/Next: `{"node": {"version": "22"}}` یا `{"next": {"version": "22"}}`
- Python/Django/Flask: `{"django": {"pythonVersion": "3.12"}}`
- PHP/Laravel: `{"laravel": {"phpVersion": "8.3"}}`

## نمونه

```json
{
  "app": "my-shop",
  "platform": "node",
  "port": 3000,
  "node": { "version": "22" }
}
```

منابع: liara-cli `src/types/liara-json.ts`، `src/commands/deploy.ts`
