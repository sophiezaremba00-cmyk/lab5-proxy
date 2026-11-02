# lab5-proxy

Кешуючий HTTP-проксі для картинок [http.cat](https://http.cat) на Node.js (модуль `http`, `commander`, `superagent`). Лише проміси та `async/await`.

## Запуск

```bash
npm install
node main.js --host 127.0.0.1 --port 3000 --cache ./cache
# або: npm start
```

Опції: `-h, --host`, `-p, --port`, `-c, --cache` — усі обов'язкові (довідка: `-?`). Для `commander` 15 потрібен Node.js ≥ 22.12.

## API

| Метод  | Шлях   | Результат |
|--------|--------|-----------|
| GET    | `/NNN` | 200, `image/jpeg`, заголовок `X-Image-Source: cache` або `http.cat`; 404, якщо картинки немає ніде |
| PUT    | `/NNN` | 201, картинка з тіла (JPEG) записується в кеш; 400, якщо тіло не JPEG |
| DELETE | `/NNN` | 200; 404, якщо картинки немає в кеші |
| інші   | —      | 405 із заголовком `Allow: GET, PUT, DELETE` |

## Перевірка

- curl: команди в `test.txt`;
- Postman: імпортуйте `postman_collection.json`. У запиті PUT оберіть файл `sample.jpg` заново, бо Postman зберігає шлях до файлу локально. Для запуску «з нуля» очистіть теку `cache`.
