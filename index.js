import {
  getFilesRecursively,
  getParent,
  getFileContent,
  getFile,
} from "@ares/files";
import {asyncConsole} from '@ares/core/console.js';
const extensionMapping = {
  mariadb: "sql",
  mysql: "sql",
  mssql: "sql",
  oracle: "sql",
  postgres: "sql",
  sqlite: "sql",
  rest: "url",
};
export async function assembleDatasource(datasourceFile) {
  const datasourceObject = (
    await import("file://" + import.meta.resolve(datasourceFile))
  ).default;
  if (!datasourceObject.path)
    datasourceObject.path = getParent(import.meta.resolve(datasourceFile));
  const extension = extensionMapping[datasourceObject.driver];
  for (const file of getFilesRecursively(
    datasourceObject.path,
    `/*.(${extension})/i`,
    true
  )) {
    datasourceObject.queries = datasourceObject.queries || {};
    const filePath = path.join(
      datasourceObject.path,
      file.replaceAll(new RegExp(/\.\w+$/i), "")
    );
    const fileName = file
      .replaceAll(new RegExp("\\.(" + extension + ")$", "i"), "")
      .replaceAll(/\/|\\/i, "_");
    const completeFilePath = getFile(datasourceObject.path, filePath);
    datasourceObject.queries[fileName] = (
      await import("file://" + completeFilePath + ".js")
    ).default;
    datasourceObject.queries[fileName].query = getFileContent(completeFilePath);
  }
  return datasourceObject;
}

/**
 * @return {array} The exported data sources
 *
 * Initialyze db object
 *
 */
export async function initAllDatasources() {
  const app = (await import(import.meta.resolve("../../../app.js"))).default;
  const datasourcesRoot = app.datasourcesRoot;
  const files = getFilesRecursively(
    datasourcesRoot,
    /(.*[\/\\]){0,1}datasource\.js/i,
    true
  );
  const array = [];
  for (const file of files) {
    asyncConsole.log("datasources", 'connection file found: "' + file + ";");
    array.push(assembleDatasource(getFile(datasourcesRoot, file)));
  }
  asyncConsole.output("datasources");
  return array;
}

export function serializeDatasource(datasource, serializationDir) {
  const serializedFile = getFile(
    serializationDir,
    datasource.name + ".datasource.js"
  );
  let serializedContent = `import * form '@ares/datasource.js';\nconst datasource = {\n`;
  for (const key in datasource) {
    if (typeof datasource[key] === "function") {
      serializedContent += `\t"${key}": ${datasource[key].toString()}},\n`;
    } else {
      serializedContent += `"\t${key}": ${JSON.stringify(datasource[key])},\n`;
    }
  }
  serializedContent += `},\n`;
}
