/// <reference types="vite/client" />

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { start_param?: string; user?: { first_name?: string; username?: string } };
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
}
interface Window {
  Telegram?: { WebApp?: TelegramWebApp };
}
