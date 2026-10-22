# پلتفرم‌های لیارا (platforms) و پورت پیش‌فرض

هر برنامه در لیارا یک «پلتفرم» دارد (مثل node یا laravel). پلتفرم تعیین می‌کند کد شما چطور ساخته (build) و اجرا شود. شناسه‌های معتبر: `node`, `next`, `react`, `vue`, `angular`, `static`, `laravel`, `php`, `django`, `flask`, `python`, `dotnet`, `go`, `docker`.

## پورت پیش‌فرض هر پلتفرم (port)

برنامه باید روی همان پورتی گوش بدهد که هنگام انتشار (release) اعلام می‌شود. اگر پورت در liara.json نیامده باشد، این مقادیر استفاده می‌شود (همان رفتار liara-cli):

- `node`، `next`، `docker`: پورت 3000
- `static`، `react`، `vue`، `angular`، `laravel`، `php`، `django`، `flask`، `python`، `dotnet`: پورت 80
- `go`: پورت 8080

اگر برنامه روی پورت دیگری بالا بیاید، انتشار در وضعیت UNHEALTHY می‌ماند یا سایت خطای 502 می‌دهد. راه‌حل: پورت را در liara.json یا هنگام انتشار درست کنید.

## Node.js و Next.js

- لیارا `npm install` و در صورت وجود `npm run build` را اجرا می‌کند و برنامه را با `npm start` بالا می‌آورد؛ پس اسکریپت `start` در package.json لازم است.
- نسخه‌ی Node از `engines.node` در package.json یا فیلد `node.version` در liara.json خوانده می‌شود. نسخه‌های پشتیبانی‌شده: 18، 20، 22، 24 (و نسخه‌های قدیمی‌تر زوج).
- پوشه‌ی `node_modules` آپلود نمی‌شود؛ وابستگی‌ها روی سرور نصب می‌شوند.
- خطای رایج: `JavaScript heap out of memory` یعنی حافظه‌ی پلن کم است یا نشت حافظه وجود دارد.

## React، Vue و Angular (فرانت‌اند)

- کد با `npm run build` ساخته می‌شود و خروجی به‌صورت فایل‌های ایستا سرو می‌شود (پورت 80).
- متغیرهای محیطی این پروژه‌ها هنگام build در کد قرار می‌گیرند؛ تغییرشان نیاز به انتشار دوباره دارد.

## سایت ایستا (static)

- فقط فایل‌های HTML/CSS/JS؛ فایل `index.html` باید در ریشه‌ی پروژه باشد.

## Laravel و PHP

- پوشه‌ی `vendor` آپلود نمی‌شود و وابستگی‌ها با composer نصب می‌شوند.
- نسخه‌ی PHP از composer.json یا `laravel.phpVersion`/`php.phpVersion` در liara.json (۷٫۲ تا ۸٫۴).
- `APP_KEY` و تنظیمات پایگاه داده (`DB_*`) باید به‌صورت متغیر محیطی تنظیم شوند.

## Django، Flask و Python

- پوشه‌های `venv`/`.venv` و فایل `.env` آپلود نمی‌شوند؛ وابستگی‌ها از `requirements.txt` نصب می‌شوند.
- نسخه‌ی Python با `pythonVersion` در liara.json (۳٫۷ تا ۳٫۱۳).
- خطای رایج: `ModuleNotFoundError` یعنی بسته در requirements.txt نیامده است.

## .NET و Go

- .NET: فایل `.csproj` لازم است؛ پورت پیش‌فرض 80. پوشه‌های bin/obj آپلود نمی‌شوند.
- Go: فایل `go.mod` لازم است؛ پورت پیش‌فرض 8080.

## Docker

- اگر Dockerfile در ریشه باشد، لیارا ایمیج را از روی آن می‌سازد. پورت را با `EXPOSE` یا liara.json مشخص کنید.

## فایل‌هایی که آپلود نمی‌شوند (ignore)

مثل liara-cli: `.git`، `node_modules`، `.next`، `.idea`، `.vscode`، `liara.json`، `.DS_Store` و الگوهای `.liaraignore` (اولویت اول)، `.dockerignore` یا `.gitignore` هر پوشه. حداکثر حجم فشرده‌ی کد: ۲۵۶ مگابایت. این دستیار فایل‌های `.env` را هم هرگز آپلود نمی‌کند؛ مقدارها باید متغیر محیطی شوند.

منابع: liara-cli (github.com/liara-cloud/cli: `src/utils/get-port.ts`، `src/utils/create-archive.ts`، `src/services/get-platform-version.ts`، `src/constants.ts`)، https://developers.liara.ir
