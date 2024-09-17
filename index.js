import {
  getFilesRecursively,
  getParent,
  getFileContent,
  getFile,
  getAbsolutePath,
  getFileName,
  getRelativePathFrom,
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
  const datasourceObject = {...(
    await import("file://" + datasourceFile)
  )};
  
  if (!datasourceObject.path)
    datasourceObject.path = getParent(datasourceFile);
  const extension = Object.entries(datasourceObject.environments).map(([key, databases]) => 
    Object.entries(databases).map(([key1, value]) =>value.queryExtensions)?.join("|") || ''
  )?.join("|") || '';
  if(extension)
  {
      for (const file of getFilesRecursively(
        datasourceObject.path,
        new RegExp( `.*\.(${extension})$`, "i"),
        true
      )) {
      datasourceObject.queries = datasourceObject.queries || {};
      const completeFilePath =  file.replaceAll(/\.\w+$/gi, "");
      const fileName = getFileName(completeFilePath);
      const mapperFileObject = (
        await import("file://" + completeFilePath + ".js")
      ).default;
      if(mapperFileObject){
          datasourceObject.queries[fileName] = mapperFileObject;
          datasourceObject.queries[fileName].query = getFileContent(file);
      }
    }
  }  
  return datasourceObject;
}

/**
 * @return {array} The exported data sources
 *
 * Initialyze db object
 *
 */
export async function initAllDatasources(datasourcesRoot) {
  const files = getFilesRecursively(
    datasourcesRoot,
    /(.*[\/\\]){0,1}datasource\.js/i,
    true
  );
  const array = [];
  for (const file of files) {
    asyncConsole.log("datasources", 'connection file found: "' + file + ";");
    array.push(await assembleDatasource(file));
    asyncConsole.output("datasources",array);
  }
  asyncConsole.output("datasources",array);
  console.log("datasources",array);
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
