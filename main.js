import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

import { Command, InvalidArgumentError } from 'commander';
import superagent from 'superagent';

// Максимальний розмір зображення — 10 МБ.
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

// Час очікування відповіді від http.cat.
const RESPONSE_TIMEOUT = 10000;
const REQUEST_TIMEOUT = 15000;

const program = new Command();

function parsePort(value) {
    const port = Number(value);

    if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
    ) {
        throw new InvalidArgumentError(
            'Порт має бути цілим числом від 1 до 65535.'
        );
    }

    return port;
}

program
    .name('http-image-proxy')
    .description(
        'HTTP-проксі для отримання та кешування зображень http.cat'
    )
    .helpOption('-? --help', 'показати довідку')
    .requiredOption(
        '-h, --host <address>',
        'адреса, на якій працює сервер'
    )
    .requiredOption(
        '-p, --port <number>',
        'порт сервера',
        parsePort
    )
    .requiredOption(
        '-c, --cache <path>',
        'шлях до теки кешу'
    );

program.parse(process.argv);

const options = program.opts();

const HOST = options.host;
const PORT = options.port;
const CACHE_DIR = path.resolve(options.cache);


function isJpeg(buffer) {
    return (
        Buffer.isBuffer(buffer) &&
        buffer.length >= 3 &&
        buffer[0] === 0xFF &&
        buffer[1] === 0xD8 &&
        buffer[2] === 0xFF
    );
}


function getCacheFilePath(statusCode) {
    return path.join(CACHE_DIR, `${statusCode}.jpg`);
}

function sendJson(res, statusCode, data, headers = {}) {
    const body = Buffer.from(JSON.stringify(data));

    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        ...headers
    });

    res.end(body);
}

function getStatusCodeFromUrl(requestUrl) {
    try {
        const url = new URL(requestUrl, 'http://localhost');

        const match = url.pathname.match(/^\/(\d{3})$/);

        if (!match) {
            return null;
        }

        const statusCode = Number(match[1]);

        if (statusCode < 100 || statusCode > 599) {
            return null;
        }

        return statusCode;
    } catch {
        return null;
    }
}


async function readFromCache(filePath) {
    try {
        const image = await fs.readFile(filePath);

        if (!isJpeg(image)) {
            await fs.unlink(filePath);
            return null;
        }

        return image;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }

        throw error;
    }
}

async function saveToCache(filePath, image) {
    await fs.mkdir(CACHE_DIR, {
        recursive: true
    });

    const temporaryPath = `${filePath}.${Date.now()}.tmp`;

    try {
        await fs.writeFile(temporaryPath, image, {
            flag: 'wx'
        });

        await fs.rename(temporaryPath, filePath);
    } catch (error) {
        try {
            await fs.rm(temporaryPath, {
                force: true
            });
        } catch {
        
        }

        throw error;
    }
}

/**
 * Видаляє файл із кешу.
 */
async function deleteFromCache(filePath) {
    await fs.unlink(filePath);
}

async function fetchFromHttpCat(statusCode) {
    const url = `https://http.cat/${statusCode}`;

    const response = await superagent
        .get(url)
        .set('Accept', 'image/jpeg')
        .buffer(true)
        .maxResponseSize(MAX_IMAGE_SIZE)
        .timeout({
            response: RESPONSE_TIMEOUT,
            deadline: REQUEST_TIMEOUT
        });

    const contentType = (
        response.headers['content-type'] || ''
    )
        .split(';')[0]
        .trim()
        .toLowerCase();

    if (response.status !== 200) {
        throw new Error(
            `http.cat повернув статус ${response.status}.`
        );
    }

    if (contentType !== 'image/jpeg') {
        throw new Error(
            `Очікувався image/jpeg, отримано ${contentType}.`
        );
    }

    const image = response.body;

    if (!isJpeg(image)) {
        throw new Error(
            'Отримані дані не є JPEG-зображенням.'
        );
    }

    return image;
}

async function handleGet(res, statusCode) {
    const filePath = getCacheFilePath(statusCode);

    let image = await readFromCache(filePath);

    let source = 'cache';

    if (image === null) {
        try {
            image = await fetchFromHttpCat(statusCode);
        } catch (error) {
            console.error(
                'Помилка отримання картинки з http.cat:',
                error.message
            );

            sendJson(res, 404, {
                error: 'Картинку не знайдено на http.cat або виникла помилка запиту.',
                statusCode
            });

            return;
        }

        await saveToCache(filePath, image);

        source = 'http.cat';
    }

    res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': image.length,
        'X-Image-Source': source
    });

    res.end(image);
}

async function readRequestBody(req) {
    const chunks = [];

    let totalSize = 0;
    let tooLarge = false;

    for await (const chunk of req) {
        totalSize += chunk.length;

        if (totalSize > MAX_IMAGE_SIZE) {
            tooLarge = true;
            chunks.length = 0;
            continue;
        }

        if (!tooLarge) {
            chunks.push(Buffer.from(chunk));
        }
    }

    if (tooLarge) {
        return {
            tooLarge: true,
            body: null
        };
    }

    return {
        tooLarge: false,
        body: Buffer.concat(chunks)
    };
}


async function handlePut(req, res, statusCode) {
    const contentType = (
        req.headers['content-type'] || ''
    )
        .split(';')[0]
        .trim()
        .toLowerCase();

    const allowedTypes = [
        'image/jpeg',
        'application/octet-stream'
    ];

    if (!allowedTypes.includes(contentType)) {
        req.resume();

        sendJson(res, 400, {
            error: 'Непідтримуваний Content-Type.'
        });

        return;
    }

    const result = await readRequestBody(req);

    if (result.tooLarge) {
        sendJson(res, 413, {
            error: 'Розмір зображення перевищує 10 МБ.'
        });

        return;
    }

    const image = result.body;

    if (!image || image.length === 0) {
        sendJson(res, 400, {
            error: 'Тіло PUT-запиту порожнє.'
        });

        return;
    }

    if (!isJpeg(image)) {
        sendJson(res, 400, {
            error: 'Передані дані не є JPEG-зображенням.'
        });

        return;
    }

    const filePath = getCacheFilePath(statusCode);

    await saveToCache(filePath, image);

    sendJson(res, 201, {
        message: 'Картинку успішно записано в кеш.',
        statusCode,
        file: `${statusCode}.jpg`
    });
}


async function handleDelete(res, statusCode) {
    const filePath = getCacheFilePath(statusCode);

    try {
        await deleteFromCache(filePath);

        sendJson(res, 200, {
            message: 'Картинку успішно видалено з кешу.',
            statusCode
        });
    } catch (error) {
        if (error.code === 'ENOENT') {
            sendJson(res, 404, {
                error: 'Картинку не знайдено в кеші.',
                statusCode
            });

            return;
        }

        throw error;
    }
}


async function handleRequest(req, res) {
    const allowedMethods = [
        'GET',
        'PUT',
        'DELETE'
    ];

    if (!allowedMethods.includes(req.method)) {
        req.resume();

        sendJson(
            res,
            405,
            {
                error: 'Метод HTTP не підтримується.'
            },
            {
                Allow: 'GET, PUT, DELETE'
            }
        );

        return;
    }

    const statusCode = getStatusCodeFromUrl(req.url || '/');

    if (statusCode === null) {
        sendJson(res, 404, {
            error: 'Неправильний шлях. Використовуйте формат /NNN.'
        });

        return;
    }

    switch (req.method) {
        case 'GET':
            await handleGet(res, statusCode);
            break;

        case 'PUT':
            await handlePut(req, res, statusCode);
            break;

        case 'DELETE':
            await handleDelete(res, statusCode);
            break;
    }
}

async function main() {
    // Створення теки кешу, якщо вона не існує.
    await fs.mkdir(CACHE_DIR, {
        recursive: true
    });

    // Створення HTTP-сервера.
    // Це єдиний колбек у програмі, дозволений методичкою.
    const server = http.createServer(async (req, res) => {
        try {
            await handleRequest(req, res);
        } catch (error) {
            console.error(
                'Помилка обробки HTTP-запиту:',
                error.message
            );

            if (res.headersSent) {
                res.destroy();
                return;
            }

            sendJson(res, 500, {
                error: 'Внутрішня помилка сервера.'
            });
        }
    });

    // Запуск сервера з параметрами командного рядка.
    server.listen(PORT, HOST);

    // Очікування успішного запуску сервера.
    await once(server, 'listening');

    console.log('HTTP-сервер успішно запущено.');
    console.log(`Адреса: http://${HOST}:${PORT}`);
    console.log(`Тека кешу: ${CACHE_DIR}`);
    console.log('Доступні методи: GET, PUT, DELETE');
}


try {
    await main();
} catch (error) {
    console.error('Помилка запуску сервера:', error.message);

    process.exitCode = 1;
}