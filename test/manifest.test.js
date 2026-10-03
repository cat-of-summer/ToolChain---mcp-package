import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-manifest-'));
process.env.TK_ROOT = root;
process.env.TK_UPDATE_CHECK = '0';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = await import('../src/server.js');
const { ALL, GROUPS, select } = await import('../src/tools/groups.js');

// Манифест агент вычитывает при каждом подключении, до первого полезного действия.
// Тест держит верхнюю границу и заодно ловит схему, которая не сворачивается в
// JSON Schema: без него опечатка в описании инструмента валит сервер при зелёных тестах.
// Самое тяжёлое — conn_open: схема цели целиком; остальные удалённые берут conn строкой.
const MANIFEST_BUDGET = 40_000;

async function connect(spec) {
  const { server } = await createServer({ spec });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('сервер поднимается и отдаёт все инструменты', async () => {
  const { client } = await connect('all');
  const { tools } = await client.listTools();

  assert.equal(tools.length, ALL.length, 'в манифесте столько же инструментов, сколько объявлено');

  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 40, `${tool.name}: описание пустое или куцее`);
    assert.ok(tool.inputSchema, `${tool.name}: схема не свернулась`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('имена инструментов уникальны', () => {
  const names = ALL.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, `дубли: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
});

test('манифест помещается в бюджет', async () => {
  const { client } = await connect('all');
  const { tools } = await client.listTools();
  const size = Buffer.byteLength(JSON.stringify(tools));

  const heaviest = tools
    .map((tool) => ({ name: tool.name, bytes: Buffer.byteLength(JSON.stringify(tool)) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);

  assert.ok(
    size <= MANIFEST_BUDGET,
    `манифест ${size} Б при потолке ${MANIFEST_BUDGET}. Самые тяжёлые: ${JSON.stringify(heaviest)}`,
  );
});

test('адрес сокращает набор, но служебные остаются', async () => {
  const { client } = await connect('db+audit');
  const names = (await client.listTools()).tools.map((tool) => tool.name);

  assert.ok(names.includes('db_query'));
  assert.ok(names.includes('audit_query'));
  assert.ok(names.includes('toolkit_info'), 'toolkit_info есть на любом адресе');
  assert.ok(names.includes('help'), 'help есть на любом адресе');
  assert.equal(names.includes('ssh_exec'), false);
  assert.equal(names.includes('exec'), false);
});

test('псевдонимы раскрываются, порядок не важен', () => {
  assert.deepEqual(select('audit+db').groups.sort(), select('db+audit').groups.sort());
  assert.ok(select('local').groups.includes('env'));
  assert.equal(select('local').groups.includes('ssh'), false);
  assert.ok(select('remote').groups.includes('docker'));
  assert.ok(select('transfer').groups.includes('ws'), 'файлы сервера без рабочей области бесполезны');
});

test('неизвестная группа называет существующие', () => {
  assert.throws(() => select('нетакой'), new RegExp(Object.keys(GROUPS)[0]));
});

test('удалённые инструменты берут conn и объявляют вид цели', () => {
  for (const tool of ALL) {
    if (!tool.remote) continue;
    assert.ok(['shell', 'files', 'docker', 'db'].includes(tool.remote), `${tool.name}: неизвестный вид ${tool.remote}`);
    assert.ok(tool.input.conn, `${tool.name}: нет параметра conn`);
  }
});

// Человек видит вопрос о записи на сервер; без summary ему показали бы голое имя инструмента.
test('у изменяющих удалённых инструментов есть текст для человека', () => {
  for (const tool of ALL) {
    if (!tool.remote || !tool.mutating) continue;
    assert.ok(tool.summary, `${tool.name}: нет summary, человеку нечего показать`);
  }
});
