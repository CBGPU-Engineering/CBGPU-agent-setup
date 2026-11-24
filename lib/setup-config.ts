import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

export async function readHermesModel(file: string): Promise<string> {
  const source = await readFile(file, 'utf8').catch(() => {
    throw new Error('Hermes 설정 파일을 열 수 없어요. config.yaml이 있는지 확인해 주세요.');
  });
  let model: unknown;
  try {
    const document = parseDocument(source, { logLevel: 'silent', prettyErrors: false, merge: false });
    if (document.errors.length) throw document.errors[0];
    const config = document.toJS({ maxAliasCount: 20 });
    model = typeof config?.model === 'string' ? config.model : config?.model?.default;
  } catch {
    throw new Error('Hermes 설정 파일을 읽지 못했어요. config.yaml의 YAML 형식을 확인해 주세요.');
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('Hermes 설정에서 연결할 모델을 찾지 못했어요. config.yaml의 model 설정을 확인해 주세요.');
  }
  return model.trim();
}
