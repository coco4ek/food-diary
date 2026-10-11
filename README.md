# ккал·дневник

Дневник калорий по фото. Делаешь снимок тарелки, а модель распознаёт блюда, оценивает вес порций и считает калории и БЖУ с разбивкой по ингредиентам. Приложение ставится на телефон как PWA (иконка на главном экране, открывается без браузерной строки).

- Вход только по одноразовым ссылкам-приглашениям: без паролей и почты.
- Данные хранятся в SQLite на вашем сервере. Фото никуда не сохраняются: их уменьшают на телефоне, отправляют модели и после подсчёта выбрасывают.
- Подходит любой OpenAI-совместимый API с поддержкой картинок (OpenRouter, OpenAI, Gemini и другие).
- Дневной лимит распознаваний на человека защищает ваш бюджет на API.

## Стек

Node.js 22, TypeScript, Fastify, better-sqlite3. Фронтенд — один HTML-файл и чистый JS без сборки. Всё работает в одном Docker-контейнере.

## Развёртывание

Понадобятся сервер с Docker, домен (или поддомен), указывающий на сервер, и ключ API модели.

```bash
git clone <адрес репозитория> kkal && cd kkal
cp .env.example .env
nano .env          # BASE_URL, LLM_API_KEY, при желании LLM_MODEL
docker compose up -d --build
docker compose logs kkal | grep -A1 "Ссылка администратора"
```

При первом запуске, пока пользователей нет, сервер пишет в лог ссылку администратора. Откройте её на телефоне, и вы вошли.

### HTTPS через Caddy

Установка на телефон и безопасная cookie сессии работают только по HTTPS. Если Caddy установлен прямо на сервере, добавьте в `Caddyfile`:

```
kkal.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Если Caddy работает в Docker (например, вместе с n8n), уберите блок `ports` из `docker-compose.yml`, подключите сервис к сети Caddy и проксируйте по имени контейнера:

```yaml
services:
  kkal:
    # ...
    networks: [caddy]
networks:
  caddy:
    external: true   # имя сети, в которой работает ваш Caddy
```

```
kkal.example.com {
    reverse_proxy kkal:3000
}
```

После правки выполните `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` (или перезапустите контейнер Caddy).

Если перед сервером стоит ещё один прокси (nginx и т. п.), он должен передавать заголовки `Host` и `X-Forwarded-Proto`, а `BASE_URL` должен совпадать с адресом, который видят люди.

## Приглашения

- **Из приложения:** администратор видит внизу поле «Пригласить», вводит имя и получает ссылку. Она действует 7 дней и срабатывает один раз.
- **Вход на другом устройстве:** кнопка «Войти на другом устройстве» выдаёт ссылку на 15 минут.
- **Из консоли:**

```bash
docker compose exec kkal node dist/cli.js invite "Маша"           # обычный участник
docker compose exec kkal node dist/cli.js invite "Саша" --admin   # администратор
docker compose exec kkal node dist/cli.js users                    # список
docker compose exec kkal node dist/cli.js login 2                  # ссылка входа для пользователя с id 2
```

## Установка на телефон

- **iPhone:** откройте сайт в Safari → «Поделиться» → «На экран „Домой“».
- **Android:** Chrome сам предложит «Установить приложение», либо меню ⋮ → «Добавить на главный экран».

## Настройки (`.env`)

| Переменная | Что делает | По умолчанию |
|---|---|---|
| `BASE_URL` | Публичный адрес приложения, из него собираются ссылки-приглашения | `http://localhost:3000` |
| `LLM_BASE_URL` | Адрес OpenAI-совместимого API | `https://openrouter.ai/api/v1` |
| `LLM_API_KEY` | Ключ API | — |
| `LLM_MODEL` | Модель с поддержкой изображений | `anthropic/claude-sonnet-4.5` |
| `DAILY_LIMIT` | Распознаваний на человека в день | `40` |
| `LLM_TIMEOUT_MS` | Таймаут запроса к модели | `90000` |
| `PORT` | Порт внутри контейнера | `3000` |

Точность сильно зависит от модели. Перед тем как выбрать дешёвую, проверьте её на нескольких своих фото.

## Резервная копия

Все данные лежат в одном файле `data/kkal.sqlite`. Копировать его на ходу можно так:

```bash
docker compose exec kkal node -e "require('better-sqlite3')('/app/data/kkal.sqlite').backup('/app/data/backup.sqlite').then(()=>console.log('ok'))"
```

## Обновление

```bash
git pull && docker compose up -d --build
```

## Локальная разработка

```bash
npm install
cp .env.example .env   # BASE_URL=http://localhost:3000
npm run dev
```

## API

Все маршруты, кроме `/i/:token` и `/healthz`, требуют cookie сессии.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/i/:token` | Вход по приглашению или ссылке устройства |
| GET / PUT | `/api/me` | Профиль и дневная цель |
| GET | `/api/days?from=YYYY-MM-DD&to=YYYY-MM-DD` | Записи за период |
| PUT | `/api/days/:date` | Сохранить день целиком (`{entries:[…]}`) |
| POST | `/api/estimate` | Распознать еду: `{text, images:[dataURL], date}` → `{dishes, note}` |
| POST | `/api/login-link` | Ссылка для входа на другом устройстве |
| POST | `/api/invites` | Приглашение (только администраторы) |
| POST | `/api/logout` | Выход |
