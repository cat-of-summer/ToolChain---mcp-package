import { z } from 'zod';
import { pick } from '../i18n.js';
import { cfg } from '../config.js';
import * as dbTransport from '../transport/db/index.js';
import { classify } from '../transport/db/sql.js';
import { connParam } from '../target.js';
import * as ws from '../workspace.js';

const GROUP = 'db';

export const tools = [
  {
    name: 'db_tables',
    group: GROUP,
    remote: 'db',
    mutating: false,
    title: pick({ ru: 'Таблицы базы', en: 'Database tables' }),
    description: pick({
      ru: 'Список таблиц и представлений. По умолчанию через SSH-туннель к серверу, поэтому '
        + 'порт базы наружу открывать не нужно; db.via меняет путь.',
      en: 'Tables and views. By default through an SSH tunnel to the server, so the database '
        + 'port needs no public exposure; db.via changes the route.',
    }),
    input: { conn: connParam },
    run: async (args, { resolved, approveHostKey }) => ({ data: await dbTransport.tables(resolved, { approveHostKey }) }),
  },

  {
    name: 'db_schema',
    group: GROUP,
    remote: 'db',
    mutating: false,
    title: pick({ ru: 'Схема таблицы', en: 'Table schema' }),
    description: pick({ ru: 'Столбцы таблицы: тип, обязательность, значение по умолчанию.', en: 'Table columns: type, nullability, default.' }),
    input: { conn: connParam, table: z.string(), schema: z.string().optional() },
    run: async (args, { resolved, approveHostKey }) => ({
      data: await dbTransport.columns(resolved, args.table, { schema: args.schema || '', approveHostKey }),
    }),
  },

  {
    name: 'db_query',
    group: GROUP,
    remote: 'db',
    // Читающий запрос выполняется сразу, изменяющий — только после подтверждения.
    // Классификация разбирает SQL, а не доверяет намерению вызывающего.
    mutating: (args) => !classify(args.sql).readonly,
    title: pick({ ru: 'Запрос к базе', en: 'Database query' }),
    description: pick({
      ru: 'Выполняет SQL на базе цели (блок db). SELECT идёт сразу, изменяющий запрос — после подтверждения '
        + 'человека. Несколько запросов через «;» в одном вызове отклоняются: подтверждать надо то, '
        + 'что человек прочитал целиком. Параметры передавайте в params, а не склейкой строк.',
      en: 'Runs SQL against the target database (the db block). A SELECT runs immediately, a mutating query '
        + 'only after human confirmation. Several statements separated by ";" are rejected: the human '
        + 'must confirm exactly what runs. Pass parameters in params instead of string concatenation.',
    }),
    input: {
      conn: connParam,
      sql: z.string(),
      params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      maxRows: z.number().int().positive().optional(),
    },
    summary: (args, info) => `Выполнить на базе «${info.label}»: ${args.sql.slice(0, 500)}`,
    details: (args, info) => ({
      база: `${info.target.db.engine} ${info.target.db.database}`,
      сервер: info.target.db.via === 'direct' ? info.target.db.host : info.label,
      параметры: args.params,
    }),
    run: async (args, { resolved, approveHostKey }) => {
      const shape = classify(args.sql);
      if (shape.count > 1) {
        throw new Error(
          `в одном вызове ${shape.count} запросов (${shape.kinds.join(', ')}). Выполняйте по одному: `
          + 'подтверждать человек должен ровно то, что уйдёт в базу',
        );
      }

      const res = await dbTransport.query(resolved, args.sql, {
        params: args.params || [],
        maxRows: Math.min(args.maxRows || cfg.dbMaxRows, cfg.dbMaxRows),
        approveHostKey,
      });

      const first = res.results[0] || { columns: [], rows: [], rowCount: 0 };
      return {
        data: { via: res.via, readonly: shape.readonly, ...first, warning: res.warning },
        command: args.sql,
        stdout: JSON.stringify(first.rows),
      };
    },
  },

  {
    name: 'db_dump',
    group: GROUP,
    remote: 'db',
    mutating: false,
    title: pick({ ru: 'Дамп базы', en: 'Database dump' }),
    description: pick({
      ru: 'Снимает дамп штатной утилитой (pg_dump или mysqldump) в файл рабочей области — в ответе '
        + 'путь и ссылка, а не содержимое. Базу не меняет.',
      en: 'Takes a dump with the native utility (pg_dump or mysqldump) into a workspace file — the reply '
        + 'carries the path and a link, not the contents. Changes nothing in the database.',
    }),
    input: {
      conn: connParam,
      table: z.string().optional(),
      schemaOnly: z.boolean().optional(),
      dataOnly: z.boolean().optional(),
      to: z.string().optional().describe(pick({ ru: 'путь в рабочей области; по умолчанию dumps/<база>.sql', en: 'workspace path; defaults to dumps/<db>.sql' })),
    },
    run: async (args, { resolved, approveHostKey, secrets }) => {
      const name = `${resolved.config.database || 'dump'}${args.table ? `.${args.table}` : ''}.sql`;
      const file = ws.output('dumps', name, args.to || `dumps/${ws.safeName(name)}`);
      const res = await dbTransport.dump(resolved, {
        table: args.table,
        schemaOnly: args.schemaOnly,
        dataOnly: args.dataOnly,
        outFile: file,
        approveHostKey,
        secrets,
      });

      return {
        data: { ...ws.describe(file), bytes: res.bytes, via: res.via, warning: res.warning },
        command: res.command,
      };
    },
  },
];
