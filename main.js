
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Command } from 'commander';

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
        // Тимчасова відповідь до реалізації HTTP-методів.
        res.writeHead(501, {
            'Content-Type': 'text/plain; charset=utf-8'
        });

        res.end('Обробник запитів буде реалізовано на наступних етапах.');
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
