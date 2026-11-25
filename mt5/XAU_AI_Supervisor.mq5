#property strict
#property version   "1.00"
#property description "Read-only XAUUSD candle and account-risk bridge for XAU AI Supervisor"

input string InpWorkerUrl = "https://xau-ai-supervisor.novarw0hnqiw.workers.dev";
input string InpIngestSecret = "";
input int    InpTimerSeconds = 5;
input int    InpRiskPushSeconds = 30;
input int    InpBootstrapBars = 200;
input int    InpHttpTimeoutMs = 10000;

string   g_symbol = "";
string   g_equityKey = "";
string   g_dateKey = "";
int      g_utcDayKey = 0;
double   g_dayStartEquity = 0.0;
bool     g_riskBaselineReady = false;
datetime g_lastRiskPush = 0;

datetime g_lastM1 = 0;
datetime g_lastM5 = 0;
datetime g_lastM30 = 0;
datetime g_lastM1Attempt = 0;
datetime g_lastM5Attempt = 0;
datetime g_lastM30Attempt = 0;

// The bridge never sends, modifies, or closes trading orders.
int OnInit()
{
   g_symbol = _Symbol;
   string checkSymbol = g_symbol;
   StringToUpper(checkSymbol);
   if(StringFind(checkSymbol, "XAUUSD") < 0 && StringFind(checkSymbol, "GOLD") < 0)
   {
      Print("XAU AI bridge: attach this EA to your broker's XAUUSD/GOLD chart. Current symbol: ", g_symbol);
      return INIT_FAILED;
   }

   if(InpIngestSecret == "" || StringFind(InpIngestSecret, "\r") >= 0 || StringFind(InpIngestSecret, "\n") >= 0)
   {
      Print("XAU AI bridge: enter the existing Cloudflare INGEST_SECRET in the EA input. Do not send it to anyone.");
      return INIT_PARAMETERS_INCORRECT;
   }

   g_equityKey = StringFormat("XAUAI_E_%I64d", AccountInfoInteger(ACCOUNT_LOGIN));
   g_dateKey   = StringFormat("XAUAI_D_%I64d", AccountInfoInteger(ACCOUNT_LOGIN));

   LoadSavedDailyBaseline();
   int timerSeconds = (InpTimerSeconds < 1 ? 5 : InpTimerSeconds);
   EventSetTimer(timerSeconds);

   BootstrapTimeframe(PERIOD_M1, "1m", g_lastM1, g_lastM1Attempt);
   BootstrapTimeframe(PERIOD_M5, "5m", g_lastM5, g_lastM5Attempt);
   BootstrapTimeframe(PERIOD_M30, "30m", g_lastM30, g_lastM30Attempt);

   PushRiskSnapshot();
   Print("XAU AI bridge started in READ-ONLY mode. Symbol=", g_symbol,
         ". No trading functions are used.");
   if(!g_riskBaselineReady)
      Print("Daily risk baseline is not verified for the current UTC day. Risk updates will begin after the next UTC midnight; NO_TRADE remains in force until then.");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTick()
{
   // All work is timer-driven to avoid doing HTTP requests on every market tick.
}

void OnTimer()
{
   RefreshDailyBaseline();

   SendNewClosedBars(PERIOD_M1, "1m", g_lastM1, g_lastM1Attempt);
   SendNewClosedBars(PERIOD_M5, "5m", g_lastM5, g_lastM5Attempt);
   SendNewClosedBars(PERIOD_M30, "30m", g_lastM30, g_lastM30Attempt);

   datetime nowUtc = TimeGMT();
   int riskInterval = (InpRiskPushSeconds < 10 ? 30 : InpRiskPushSeconds);
   if(g_lastRiskPush == 0 || nowUtc - g_lastRiskPush >= riskInterval)
      PushRiskSnapshot();
}

bool CaptureDailyBaseline(int today)
{
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(equity <= 0.0)
   {
      g_dayStartEquity = 0.0;
      g_riskBaselineReady = false;
      Print("XAU AI bridge: cannot establish UTC day-start equity; risk remains unverified.");
      return false;
   }

   datetime equitySaved = GlobalVariableSet(g_equityKey, equity);
   datetime dateSaved = GlobalVariableSet(g_dateKey, (double)today);
   if(equitySaved == 0 || dateSaved == 0)
   {
      g_dayStartEquity = 0.0;
      g_riskBaselineReady = false;
      Print("XAU AI bridge: failed to persist UTC day-start equity; risk remains unverified.");
      return false;
   }

   g_utcDayKey = today;
   g_dayStartEquity = equity;
   g_riskBaselineReady = true;
   g_lastRiskPush = 0;
   Print("XAU AI bridge: UTC daily equity baseline captured and persisted.");
   return true;
}

int UtcSecondsIntoDay()
{
   MqlDateTime utc;
   TimeToStruct(TimeGMT(), utc);
   return utc.hour * 3600 + utc.min * 60 + utc.sec;
}

void LoadSavedDailyBaseline()
{
   int today = UtcDayKey();
   g_utcDayKey = today;
   if(GlobalVariableCheck(g_equityKey) && GlobalVariableCheck(g_dateKey))
   {
      int savedDate = (int)GlobalVariableGet(g_dateKey);
      double savedEquity = GlobalVariableGet(g_equityKey);
      if(savedDate == today && savedEquity > 0.0)
      {
         g_dayStartEquity = savedEquity;
         g_riskBaselineReady = true;
         return;
      }
   }

   // Never replace an unknown intraday baseline with current equity.
   g_dayStartEquity = 0.0;
   g_riskBaselineReady = false;

   // A first launch during the first two minutes of UTC day can safely capture
   // the opening equity. Otherwise, wait until the next UTC midnight.
   if(UtcSecondsIntoDay() <= 120)
      CaptureDailyBaseline(today);
}

void RefreshDailyBaseline()
{
   int today = UtcDayKey();
   if(today != g_utcDayKey)
   {
      g_utcDayKey = today;
      g_dayStartEquity = 0.0;
      g_riskBaselineReady = false;
   }

   if(g_riskBaselineReady)
      return;

   // Retry only during the opening two-minute window. Never guess a baseline later.
   if(UtcSecondsIntoDay() <= 120)
      CaptureDailyBaseline(today);
}

int UtcDayKey()
{
   MqlDateTime utc;
   TimeToStruct(TimeGMT(), utc);
   return utc.year * 10000 + utc.mon * 100 + utc.day;
}

bool BootstrapTimeframe(ENUM_TIMEFRAMES timeframe, string label, datetime &lastSent, datetime &lastAttempt)
{
   lastAttempt = TimeGMT();
   int requested = InpBootstrapBars;
   if(requested < 55) requested = 55;
   if(requested > 200) requested = 200;

   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(g_symbol, timeframe, 1, requested, rates);
   if(copied < 55)
   {
      Print("XAU AI bridge: not enough closed bars for ", label, ". Copied=", copied);
      return false;
   }

   string body = BuildCandlePayload(label, rates, copied);
   if(body == "" || !PostJson("/market/candles", body))
   {
      Print("XAU AI bridge: initial candle upload failed for ", label, ". It will retry.");
      return false;
   }

   lastSent = rates[copied - 1].time;
   Print("XAU AI bridge: uploaded ", copied, " closed candles for ", label, ".");
   return true;
}

void SendNewClosedBars(ENUM_TIMEFRAMES timeframe, string label, datetime &lastSent, datetime &lastAttempt)
{
   if(lastSent == 0)
   {
      if(lastAttempt == 0 || TimeGMT() - lastAttempt >= 60)
         BootstrapTimeframe(timeframe, label, lastSent, lastAttempt);
      return;
   }

   int lastShift = iBarShift(g_symbol, timeframe, lastSent, true);
   if(lastShift < 0)
   {
      // The terminal may have refreshed or replaced its local history. Re-bootstrap safely.
      if(TimeGMT() - lastAttempt >= 60)
         BootstrapTimeframe(timeframe, label, lastSent, lastAttempt);
      return;
   }
   if(lastShift <= 1)
      return;

   int requested = lastShift - 1;
   if(requested > 200) requested = 200;

   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(g_symbol, timeframe, 1, requested, rates);
   if(copied <= 0)
      return;

   string body = BuildCandlePayload(label, rates, copied);
   if(body == "" || !PostJson("/market/candles", body))
   {
      Print("XAU AI bridge: candle upload failed for ", label, ". The same bars will be retried.");
      return;
   }

   lastSent = rates[copied - 1].time;
}

bool GetServerUtcOffsetSeconds(int &offsetSeconds)
{
   datetime serverNow = TimeTradeServer();
   datetime utcNow = TimeGMT();
   if(serverNow <= 0 || utcNow <= 0)
      return false;

   // Broker server offsets are normally whole hours. TimeGMT relies on a correctly
   // synchronized computer clock, so the terminal host must keep its clock accurate.
   double rawOffset = (double)serverNow - (double)utcNow;
   offsetSeconds = (int)(MathRound(rawOffset / 3600.0) * 3600.0);
   if(offsetSeconds < -12 * 3600 || offsetSeconds > 14 * 3600)
      return false;

   return true;
}

string BuildCandlePayload(string timeframe, MqlRates &rates[], int count)
{
   int serverUtcOffset = 0;
   if(!GetServerUtcOffsetSeconds(serverUtcOffset))
   {
      Print("XAU AI bridge: cannot determine broker-server UTC offset. Candle upload skipped.");
      return "";
   }

   string body = "{\"symbol\":\"XAUUSD\",\"timeframe\":\"" + timeframe + "\",\"candles\":[";
   for(int i = 0; i < count; i++)
   {
      if(i > 0) body += ",";
      long timeMs = ((long)rates[i].time - serverUtcOffset) * 1000;
      body += StringFormat(
         "{\"time\":%I64d,\"open\":%s,\"high\":%s,\"low\":%s,\"close\":%s,\"volume\":%I64d}",
         timeMs,
         DoubleToString(rates[i].open, _Digits),
         DoubleToString(rates[i].high, _Digits),
         DoubleToString(rates[i].low, _Digits),
         DoubleToString(rates[i].close, _Digits),
         rates[i].tick_volume
      );
   }
   body += "]}";
   return body;
}

void PushRiskSnapshot()
{
   if(!g_riskBaselineReady || g_dayStartEquity <= 0.0)
      return;
   if(!TerminalInfoInteger(TERMINAL_CONNECTED))
      return;

   double currentEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(currentEquity <= 0.0)
      return;

   long observedAtMs = (long)TimeGMT() * 1000;
   string body = StringFormat(
      "{\"dayStartEquity\":%s,\"currentEquity\":%s,\"observedAt\":%I64d}",
      DoubleToString(g_dayStartEquity, 2),
      DoubleToString(currentEquity, 2),
      observedAtMs
   );

   if(PostJson("/risk/snapshot", body))
      g_lastRiskPush = TimeGMT();
}

bool PostJson(string path, string body)
{
   if(!TerminalInfoInteger(TERMINAL_CONNECTED))
      return false;

   string baseUrl = InpWorkerUrl;
   while(StringLen(baseUrl) > 0 && StringSubstr(baseUrl, StringLen(baseUrl) - 1, 1) == "/")
      baseUrl = StringSubstr(baseUrl, 0, StringLen(baseUrl) - 1);

   string url = baseUrl + path;
   string headers = "Content-Type: application/json\r\nx-ingest-secret: " + InpIngestSecret + "\r\n";
   char requestData[];
   int dataSize = StringToCharArray(body, requestData, 0, WHOLE_ARRAY, CP_UTF8);
   if(dataSize <= 1)
      return false;
   ArrayResize(requestData, dataSize - 1); // Remove the null terminator.

   char responseData[];
   string responseHeaders;
   ResetLastError();
   int status = WebRequest("POST", url, headers, InpHttpTimeoutMs, requestData, responseData, responseHeaders);
   if(status == -1)
   {
      Print("XAU AI bridge: WebRequest failed. Error=", GetLastError(),
            ". Check MT5 Options > Expert Advisors > Allow WebRequest for listed URL.");
      return false;
   }

   if(status < 200 || status >= 300)
   {
      string responseText = CharArrayToString(responseData, 0, -1, CP_UTF8);
      Print("XAU AI bridge: Worker returned HTTP ", status, ". Response=", responseText);
      return false;
   }
   return true;
}
