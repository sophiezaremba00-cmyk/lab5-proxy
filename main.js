import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { Command } from 'commander';
import superagent from 'superagent';

// 1. Налаштування командного рядка

const program = new Command();

program
    .name('http-image-proxy')
    .description('Кешуючий HTTP-проксі для зображень http.cat')
    .helpOption('-? --help')
    .requiredOption('-h, --host <address>', 'Адреса сервера')
    .requiredOption('-p, --port <number>', 'Порт сервера')
    .requiredOption('-c, --cache <path>', 'Тека кешу');

program.parse(process.argv);

const options = program.opts();
const HOST = options.host;
const PORT = Number(options.port);
const CACHE_DIR = path.resolve(options.cache);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    program.error('Порт має бути цілим числом від 1 до 65535.');
}

// 2. Допоміжні функції

function getCachePath(code) {
   return path.join(CACHE_DIR, `${code}.jpg`);
}

function isJpeg(data) {
    return Buffer.isBuffer(data) &&
        data.length >= 3 &&
        data[0] === 0xFF &&
        data[1] === 0xD8 &&
        data[2] === 0xFF;
}

function sendJson(res, status, data, headers = {}) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        ...headers
    });
    res.end(JSON.stringify(data));
}

function getStatusCode(requestUrl) {
    try {
       const pathname = new URL(
    requestUrl,
    'http://localhost'
).pathname;

const match = pathname.match(/^\/(\d{3})$/);

        if (!match) return null;

        const code = Number(match[1]);

        return code >= 100 && code <= 599 ? code : null;
    } catch {
        return null;
    }
}

// 3. Робота з кешем

async function readCache(filePath) {
    try {
        const image = await fs.readFile(filePath);

        if (!isJpeg(image)) {
            await fs.rm(filePath, { force: true });
            return null;
        }

        return image;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function saveCache(filePath, image) {
    await fs.mkdir(CACHE_DIR, { recursive: true });

    const tempPath = `${filePath}.${randomUUID()}.tmp`;

    try {
        await fs.writeFile(tempPath, image);
        await fs.rename(tempPath, filePath);
    } catch (error) {
        try {
            await fs.rm(tempPath, { force: true });
        } catch {
            // Ігноруємо помилку видалення тимчасового файлу.
        }

        throw error;
    }
}

// 4. Отримання картинки з http.cat

async function fetchImage(code) {
    const response = await superagent
        .get(`https://http.cat/${code}`)
        .buffer(true)
        .maxResponseSize(10 * 1024 * 1024)
        .timeout({
            response: 10000,
            deadline: 15000
        });

    const contentType = (
        response.headers['content-type'] || ''
    ).split(';')[0].trim().toLowerCase();

    if (
        response.status !== 200 ||
        contentType !== 'image/jpeg' ||
        !isJpeg(response.body)
    ) {
        throw new Error('Не вдалося отримати JPEG-картинку.');
    }

    return response.body;
}

// 5. Обробка GET

async function handleGet(res, code) {
    const filePath = getCachePath(code);

    let image = await readCache(filePath);
    let source = 'cache';

    if (!image) {
        try {
            image = await fetchImage(code);
        } catch (error) {
            console.error('Помилка http.cat:', error.message);

            sendJson(res, 404, {
                error: 'Картинку не знайдено або не вдалося отримати.'
            });

            return;
        }

        await saveCache(filePath, image);
        source = 'http.cat';
    }

    res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'X-Image-Source': source
    });

    res.end(image);
}

// 6. Отримання тіла PUT-запиту

async function readRequestBody(req) {
    const chunks = [];

    for await (const chunk of req) {
        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
}

// 7. Обробка PUT

async function handlePut(req, res, code) {
    const image = await readRequestBody(req);

    if (!isJpeg(image)) {
        sendJson(res, 400, {
            error: 'Тіло запиту не містить коректного JPEG-зображення.'
        });
        return;
    }

    await saveCache(getCachePath(code), image);

    sendJson(res, 201, {
        message: 'Картинку записано в кеш.',
        statusCode: code
    });
}

// 8. Обробка DELETE

async function handleDelete(res, code) {
    try {
        await fs.unlink(getCachePath(code));

        sendJson(res, 200, {
            message: 'Картинку видалено з кешу.',
            statusCode: code
        });
    } catch (error) {
        if (error.code === 'ENOENT') {
            sendJson(res, 404, {
                error: 'Картинку не знайдено в кеші.'
            });
            return;
        }

        throw error;
    }
}

// 9. Головний обробник запитів

async function handleRequest(req, res) {
    const methods = ['GET', 'PUT', 'DELETE'];

    if (!methods.includes(req.method)) {
        req.resume();

        sendJson(res, 405, {
            error: 'Метод HTTP не підтримується.'
        }, {
            Allow: 'GET, PUT, DELETE'
        });

        return;
    }

    const code = getStatusCode(req.url || '/');

    if (code === null) {
        req.resume();

        sendJson(res, 404, {
            error: 'Неправильний шлях. Використовуйте формат /NNN.'
        });

        return;
    }

    switch (req.method) {
        case 'GET':
            await handleGet(res, code);
            break;

        case 'PUT':
            await handlePut(req, res, code);
            break;

        case 'DELETE':
            await handleDelete(res, code);
            break;
    }
}

// 10. Створення та запуск сервера

async function main() {
    await fs.mkdir(CACHE_DIR, { recursive: true });

    const server = http.createServer(async (req, res) => {
        try {
            await handleRequest(req, res);
        } catch (error) {
            console.error('Помилка:', error.message);

            if (res.headersSent) {
                res.destroy();
                return;
            }

            sendJson(res, 500, {
                error: 'Внутрішня помилка сервера.'
            });
        }
    });

    server.listen(PORT, HOST);
    await once(server, 'listening');

    console.log('Сервер запущено!');
    console.log(`Адреса: http://${HOST}:${PORT}`);
    console.log(`Тека кешу: ${CACHE_DIR}`);
}

try {
    await main();
} catch (error) {
    console.error('Помилка запуску:', error.message);
    process.exitCode = 1;
}
