import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { SignalDatabase, Statement } from '../../src/sites/signaling.js';

/** Local preview/test boundary; never bundled into the hosted Worker. */
export function sqliteSignalStore():{db:SignalDatabase;close:()=>void} {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  for(const path of readdirSync('drizzle').filter(file=>file.endsWith('.sql')).sort())sqlite.exec(readFileSync(`drizzle/${path}`,'utf8'));
  const prepare=(sql:string):Statement=>{
    let args:SQLInputValue[]=[];
    return {
      bind(...values){args=values as SQLInputValue[];return this;},
      async first<T>(){return (sqlite.prepare(sql).get(...args) as T|undefined)??null;},
      async all<T>(){return {results:sqlite.prepare(sql).all(...args) as T[]};},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}
    };
  };
  return {db:{prepare,async batch(statements){sqlite.exec('BEGIN');try{for(const statement of statements)await statement.run();sqlite.exec('COMMIT');}catch(error){sqlite.exec('ROLLBACK');throw error;}}},close:()=>sqlite.close()};
}
