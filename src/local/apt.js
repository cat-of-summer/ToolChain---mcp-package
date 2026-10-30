import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DIRS } from '../paths.js';

// Системные программы, которых нет в mise, — пакеты Debian: LibreOffice, poppler, tesseract,
// ffmpeg. Ставятся в систему контейнера, а она при пересоздании теряется; поэтому и списки
// пакетов, и скачанные .deb лежат в томе tools (tools/.apt), а реестр помнит, что стояло.
// После пересоздания стенд ставит наборы заново из этого кэша — без сети, если её нет.
//
// Спецификации: kit:<имя> — готовый набор из KITS, apt:<пакет> — любой пакет Debian.

const pexec = promisify(execFile);

export const KITS = {
  office: {
    about: 'LibreOffice без GUI: soffice --headless --convert-to pdf|docx|xlsx|odt, шрифты, метрически совместимые с MS Office',
    packages: [
      'libreoffice-writer-nogui', 'libreoffice-calc-nogui', 'libreoffice-impress-nogui',
      'fonts-liberation', 'fonts-dejavu-core', 'fonts-crosextra-carlito', 'fonts-crosextra-caladea',
    ],
    bins: ['soffice', 'libreoffice', 'lowriter', 'localc', 'loimpress'],
  },
  pdf: {
    about: 'PDF: pdftotext, pdfinfo, pdftoppm, pdfimages (poppler), qpdf, gs (ghostscript)',
    packages: ['poppler-utils', 'qpdf', 'ghostscript'],
    bins: [],
  },
  ocr: {
    about: 'Распознавание текста на картинках и сканах: tesseract с русским и английским',
    packages: ['tesseract-ocr', 'tesseract-ocr-rus', 'tesseract-ocr-eng'],
    bins: [],
  },
  media: {
    about: 'Видео, звук, картинки: ffmpeg, ffprobe, ImageMagick (convert, identify), exiftool',
    packages: ['ffmpeg', 'imagemagick', 'libimage-exiftool-perl'],
    bins: ['convert', 'identify', 'mogrify'],
  },
};

const PACKAGE = /^[a-z0-9][a-z0-9+.-]+$/;

export const isSystem = (spec) => /^(kit|apt):/.test(spec);

/** kit:office | apt:jq → { id, packages, bins, about }. */
export function parse(spec) {
  const [kind, name] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
  if (kind === 'kit') {
    const kit = KITS[name];
    if (!kit) throw new Error(`набора «${name}» нет. Есть: ${Object.keys(KITS).map((k) => `kit:${k}`).join(', ')}; любой пакет Debian — apt:<имя>`);
    return { id: `kit:${name}`, packages: kit.packages, bins: kit.bins, about: kit.about };
  }
  if (kind === 'apt' && PACKAGE.test(name)) return { id: `apt:${name}`, packages: [name], bins: [], about: null };
  throw new Error(`«${spec}» не похоже на пакет: ожидается kit:<набор> или apt:<пакет Debian>`);
}

export const aptDir = () => path.join(DIRS.tools, '.apt');
const archivesDir = () => path.join(aptDir(), 'archives');

// apt работает со списками и кэшем в томе; Keep-Downloaded-Packages — .deb не стираются
// после установки: они и есть запас на пересоздание. Lock::Timeout — две установки подряд
// ждут друг друга, а не падают на блокировке dpkg.
const OPTS = () => [
  `-o Dir::Cache::archives=${archivesDir()}`,
  `-o Dir::State::Lists=${path.join(aptDir(), 'lists')}`,
  '-o APT::Keep-Downloaded-Packages=true',
  '-o DPkg::Lock::Timeout=900',
].join(' ');

// Списки старше суток обновляются; не обновились (нет сети) — ставим по тем, что есть, из кэша.
const INSTALL = `set -e
A="$TK_APT_DIR"
mkdir -p "$A/archives/partial" "$A/lists/partial"
if [ -z "$(find "$A/lists" -maxdepth 1 -name '*_Packages*' -mmin -1440 2>/dev/null | head -1)" ]; then
  apt-get $TK_APT_OPTS update || echo "apt-get update не прошёл — ставлю по спискам и кэшу из тома" >&2
fi
DEBIAN_FRONTEND=noninteractive apt-get $TK_APT_OPTS install -y --no-install-recommends "$@"`;

const REMOVE = `set -e
DEBIAN_FRONTEND=noninteractive apt-get $TK_APT_OPTS purge -y "$@"
DEBIAN_FRONTEND=noninteractive apt-get $TK_APT_OPTS autoremove -y --purge`;

const checkPackages = (packages) => {
  for (const name of packages) if (!PACKAGE.test(name)) throw new Error(`«${name}» не похоже на имя пакета Debian`);
  return packages;
};

/** Задача установки: argv и env для jobs.start. */
export const installJob = (packages) => ({
  argv: ['bash', '-c', INSTALL, 'apt-install', ...checkPackages(packages)],
  env: { TK_APT_DIR: aptDir(), TK_APT_OPTS: OPTS() },
});

export const removeJob = (packages) => ({
  argv: ['bash', '-c', REMOVE, 'apt-remove', ...checkPackages(packages)],
  env: { TK_APT_OPTS: OPTS() },
});

/** Стоят ли все пакеты в системе контейнера. */
export async function installed(packages) {
  try {
    const { stdout } = await pexec('dpkg-query', ['-W', '-f=${db:Status-Abbrev}\n', ...checkPackages(packages)]);
    const lines = stdout.split('\n').filter(Boolean);
    return lines.length === packages.length && lines.every((line) => line.startsWith('ii'));
  } catch {
    return false;
  }
}

/** Команды, которые принесли пакеты: по ним exec узнаёт, что набором пользовались. */
export async function binsOf(packages) {
  try {
    const { stdout } = await pexec('dpkg', ['-L', ...checkPackages(packages)], { maxBuffer: 16 * 1024 * 1024 });
    return [...new Set(stdout.split('\n')
      .filter((line) => /^\/usr\/(local\/)?s?bin\/[^/]+$/.test(line))
      .map((line) => path.basename(line)))];
  } catch {
    return [];
  }
}

/** .deb в кэше тома — снимок до и после установки даёт файлы набора. */
export function archives() {
  try {
    return fs.readdirSync(archivesDir()).filter((name) => name.endsWith('.deb'));
  } catch {
    return [];
  }
}

/** Стирает .deb набора, кроме тех, что нужны другим живым наборам. */
export function dropArchives(debs, keep = new Set()) {
  for (const name of debs || []) {
    if (keep.has(name)) continue;
    try { fs.unlinkSync(path.join(archivesDir(), name)); } catch { /* уже нет */ }
  }
}

/** Пользовался ли exec набором: в команде встречается одна из его программ. */
export function mentions(command, bins) {
  if (!command || !bins?.length) return false;
  const words = new Set(String(command).split(/[^A-Za-z0-9_.+-]+/).filter(Boolean));
  return bins.some((bin) => words.has(bin));
}
