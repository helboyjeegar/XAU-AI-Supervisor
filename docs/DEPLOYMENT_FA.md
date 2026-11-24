# راه‌اندازی مرحله‌ای XAU AI Supervisor

این راهنما برای راه‌اندازی در حساب خودت است. کد فعلی آماده توسعه و تست محلی است؛ تا وقتی D1 و Secretهای حساب تو تنظیم نشده‌اند، نمی‌توانم ادعا کنم سرویس آنلاین شده است.

## ۱) ساخت پایگاه داده D1

1. وارد Cloudflare Dashboard شو.
2. از منوی **Workers & Pages** وارد بخش **D1 SQL Database** شو.
3. گزینه **Create database** را بزن.
4. نام دیتابیس را دقیقاً `xau-ai-supervisor` بگذار.
5. شناسه Database ID را کپی کن؛ این شناسه محرمانه مثل رمز نیست، اما لازم نیست در چت ارسالش کنی.
6. در فایل `wrangler.toml`، بخش `[[d1_databases]]` را از حالت کامنت خارج کن و مقدار `database_id` را جایگزین کن.

## ۲) ساخت جدول‌ها

پس از ثبت شناسه D1 در فایل، در محیط توسعه اجرا کن:

```bash
npm install
npx wrangler d1 migrations apply xau-ai-supervisor --remote
```

این دستور جداول کندل‌ها، تحلیل‌ها، ریسک روزانه و زمینه خبر را می‌سازد.

## ۳) اتصال GitHub به Worker

1. از Cloudflare به **Workers & Pages** برو.
2. **Create application** را انتخاب کن.
3. گزینه GitHub را بزن و مخزن `helboyjeegar/XAU-AI-Supervisor` را انتخاب کن.
4. شاخه `develop` را برای شروع انتخاب کن، نه `main`.
5. Build command: `npm install && npm run check`
6. Deploy command: `npx wrangler deploy`
7. پس از Deploy، آدرس `workers.dev` نمایش داده می‌شود.

Cloudflare در هر push به شاخه متصل‌شده، build و deploy را اجرا می‌کند. نام Worker در داشبورد باید با `name` در `wrangler.toml` یکسان باشد: `xau-ai-supervisor`.

## ۴) ثبت Secretها

در Worker به مسیر **Settings → Variables and Secrets → Add** برو و این موارد را با نوع **Secret** اضافه کن:

- `INGEST_SECRET`: یک رشته تصادفی بلند که خودت تولید می‌کنی.
- `TELEGRAM_BOT_TOKEN`: توکنی که BotFather داده است.
- `TELEGRAM_CHAT_ID`: شناسه گفتگوی مجاز خودت.
- `TELEGRAM_WEBHOOK_SECRET`: رشته تصادفی دیگری برای اعتبارسنجی webhook تلگرام.

مقادیر `AI_MODEL` و `ENABLE_AI_REVIEW=false` در تنظیمات پیش‌فرض هستند. بازبین AI فقط در صورت تغییر دستی `ENABLE_AI_REVIEW=true` فعال می‌شود؛ این بازبین حق صدور یا تأیید سیگنال ندارد و فقط می‌تواند سیگنال پیشنهادی را وتو کند. سهمیه Workers AI محدود است و استفاده نامحدود رایگان نیست.

مقادیر را داخل GitHub، کد یا گفتگوی ChatGPT قرار نده. اگر توکن تلگرام جایی افشا شد، از BotFather آن را باطل و دوباره صادر کن.

## ۵) اتصال Webhook تلگرام

آدرس webhook باید این باشد:

```text
https://YOUR-WORKER.workers.dev/telegram/webhook
```

در درخواست `setWebhook`، همین URL را به‌عنوان `url` و مقدار `TELEGRAM_WEBHOOK_SECRET` را در فیلد `secret_token` ثبت کن. در نتیجه تلگرام هدر `X-Telegram-Bot-Api-Secret-Token` را می‌فرستد و Worker آن را بررسی می‌کند.

پس از اتصال، دستور `/start` و بعد `/status` را در ربات بفرست.

## ۶) وضعیت داده بازار

فعلاً موتور تحلیل به داده واقعی وصل نیست؛ endpoint دریافت کندل و قرارداد داده آماده شده‌اند. مرحله بعد، ساخت Expert Advisor برای MT5 دسکتاپ است تا کندل‌های بسته‌شده ۱، ۵ و ۳۰ دقیقه و snapshot اکوییتی را ارسال کند. نسخه Android متاتریدر امکان اجرای EA را ندارد؛ برای این مرحله MT5 دسکتاپ یا VPS لازم خواهد بود.

تا وقتی هر سه مورد زیر از منبع واقعی و تازه نرسند، سیستم عمداً سیگنال معاملاتی صادر نمی‌کند:

- کندل‌های 1m، 5m و 30m برای XAUUSD
- snapshot زمینه کلان و تقویم اقتصادی
- اکوییتی روزانه با احتساب سود/زیان شناور

## ۷) حدود رایگان بودن

Workers و D1 در پلن رایگان سقف استفاده دارند. این پروژه برای کم‌مصرف بودن طراحی شده، نه برای مصرف نامحدود. سرویس داده زنده طلا یا تقویم اقتصادی و مدل هوش مصنوعی ممکن است سهمیه یا هزینه مستقل داشته باشند. هیچ API پولی بدون تصمیم جداگانه به پروژه اضافه نمی‌شود.
