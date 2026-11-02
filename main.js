
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Command } from 'commander';
import superagent from 'superagent';
import { randomUUID } from 'node:crypto';

// Створюємо об'єкт для роботи з командним рядком.
const program = new Command();

program
    .name('lab5-proxy')
    .description('Кешуючий HTTP-проксі-сервер для зображень http.cat')
    .helpOption('-?, --help', 'показати довідку')
    .requiredOption('-h, --host <address>', 'адреса сервера')
    .requiredOption('-p, --port <number>', 'порт сервера')
    .requiredOption('-c, --cache <path>', 'шлях до теки кешу');

// Обробляємо передані аргументи.
program.parse(process.argv);

const options = program.opts();

// Отримуємо HTTP-код із шляху URL.
function getStatusCodeFromUrl(requestUrl) {
    let url;

    try {
        url = new URL(requestUrl, 'http://localhost');
    } catch {
        return null;
    }

    const match = url.pathname.match(/^\/([1-5]\d{2})$/);

    if (!match) {
        return null;
    }

    return Number(match[1]);
}

// Формуємо шлях до файлу картинки в кеші.
function getCacheFilePath(cacheDir, statusCode) {
    return path.join(cacheDir, `${statusCode}.jpg`);
}

// Надсилаємо текстову відповідь із заданим кодом.
function sendTextResponse(res, statusCode, message) {
    res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8'
    });

    res.end(message);
}

// Надсилаємо картинку користувачеві.
function sendImageResponse(res, image, source) {
    res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': image.length,
        'X-Image-Source': source
    });

    res.end(image);
}

// Зберігаємо картинку через тимчасовий файл.
async function saveImageToCache(filePath, image) {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

    try {
        await fs.writeFile(temporaryPath, image);
        await fs.rename(temporaryPath, filePath);
    } catch (error) {
        try {
            await fs.unlink(temporaryPath);
        } catch {
            // Тимчасовий файл міг не встигнути створитися.
        }

        throw error;
    }
}

// Обробляємо GET-запит для отримання картинки.
async function handleGetRequest(statusCode, cacheDir, res) {
    const filePath = getCacheFilePath(cacheDir, statusCode);

    // Спочатку перевіряємо локальний кеш.
    try {
        const cachedImage = await fs.readFile(filePath);

        // Картинка знайдена в кеші.
        sendImageResponse(res, cachedImage, 'cache');
        return;
    } catch (error) {
        // Якщо файл не знайдений, продовжуємо роботу.
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    // Якщо картинки немає, звертаємося до http.cat.
    let externalResponse;

    try {
        externalResponse = await superagent
            .get(`https://http.cat/${statusCode}`)
            .timeout({
                response: 10000,
                deadline: 15000
            });
    } catch (error) {
        console.error(
            `Помилка отримання картинки з http.cat: ${error.message}`
        );

        sendTextResponse(
            res,
            404,
            `Картинку для HTTP-коду ${statusCode} не знайдено.`
        );

        return;
    }

    // Отримуємо двійкові дані картинки.
    const image = externalResponse.body;

    if (!Buffer.isBuffer(image) || image.length === 0) {
        sendTextResponse(
            res,
            404,
            `Не вдалося отримати картинку для коду ${statusCode}.`
        );

        return;
    }

    // Зберігаємо отриману картинку в кеш.
    await saveImageToCache(filePath, image);

    // Повертаємо картинку користувачеві.
    sendImageResponse(res, image, 'http.cat');
}

// Перевіряємо правильність номера порту.
function parsePort(value) {
    const port = Number(value);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(
            'Порт повинен бути цілим числом від 1 до 65535.'
        );
    }

    return port;
}

// Запускаємо сервер.
async function startServer() {
    const host = options.host.trim();
    const port = parsePort(options.port);
    const cachePath = options.cache.trim();

    if (!host || !cachePath) {
        throw new Error('Адреса та шлях до кешу не можуть бути порожніми.');
    }

    // Створюємо теку кешу, якщо вона ще не існує.
    const cacheDir = path.resolve(cachePath);

    await fs.mkdir(cacheDir, { recursive: true });

    // Створюємо HTTP-сервер.
    const server = http.createServer(async (req, res) => {
    try {
        // Визначаємо HTTP-код із URL.
        const statusCode = getStatusCodeFromUrl(req.url);

        // Перевіряємо правильність адреси.
        if (statusCode === null) {
            sendTextResponse(
                res,
                404,
                'Неправильний шлях. Використовуйте формат /404.'
            );

            return;
        }

        // Обробляємо GET-запит.
        if (req.method === 'GET') {
            await handleGetRequest(statusCode, cacheDir, res);
            return;
        }

        // PUT і DELETE реалізуємо на наступних етапах.
        if (req.method === 'PUT' || req.method === 'DELETE') {
            sendTextResponse(
                res,
                501,
                'Цей метод ще не реалізовано.'
            );

            return;
        }

        // Обробка інших HTTP-методів.
        res.writeHead(405, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Allow': 'GET, PUT, DELETE'
        });

        res.end('Метод HTTP не підтримується.');
    } catch (error) {
        console.error(`Помилка обробки запиту: ${error.message}`);

        if (!res.headersSent) {
            sendTextResponse(
                res,
                500,
                'Внутрішня помилка сервера.'
            );
        } else {
            res.destroy();
        }
    }
});

    // Запускаємо сервер без callback-функції.
    server.listen(port, host);

    // Очікуємо запуску сервера через Promise.
    await once(server, 'listening');

    console.log(`Сервер запущено: http://${host}:${port}`);
    console.log(`Тека кешу: ${cacheDir}`);
}

// Обробляємо помилки запуску.
try {
    await startServer();
} catch (error) {
    console.error(`Помилка запуску: ${error.message}`);
    process.exitCode = 1;
}
