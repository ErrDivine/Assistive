// Go, Rust and Java: module docstrings, symbols, stubs, imports and import resolution.
import * as assert from "node:assert";
import * as path from "node:path";
import { resolveImport } from "../../src/code/context";
import { cStyleModuleString, formatOutline, outline } from "../../src/code/outline";
import { TreeSitter } from "../../src/code/treesitter";
import { findSymbol, symbolName } from "../../src/graph/model";
import type { GraphNode } from "../../src/types";

const ts = new TreeSitter(path.resolve(__dirname, "../../../node_modules/@vscode/tree-sitter-wasm/wasm"));

const GO = `// Package cache stores HTTP responses on disk.
//
// It uses ETags.
package cache

import (
	"fmt"
	nethttp "net/http"
)

import "os"

const MaxSize = 10

var defaultDir = "x"

// Cache keeps entries.
type Cache struct {
	dir string
}

type Getter interface {
	Get(key string) ([]byte, error)
}

// New makes a cache.
func New(dir string) *Cache {
	return &Cache{dir: dir}
}

func (c *Cache) Get(key string) ([]byte, error) {
	panic("not implemented")
}

func (c Cache) Put(key string, v []byte) error {
}
`;

const RUST = `//! Fetch issues and cache them.
//! Second line.

use std::collections::HashMap;
use crate::util::{a, b};

pub const MAX: usize = 3;

/// A cache.
pub struct Cache {
    dir: String,
}

pub enum Mode { A, B }

pub trait Store {
    fn get(&self, key: &str) -> Option<Vec<u8>>;
}

impl Cache {
    /// Make one.
    pub fn new(dir: &str) -> Self {
        Cache { dir: dir.to_string() }
    }

    pub async fn get(&self, key: &str) -> Option<Vec<u8>> {
        todo!()
    }
}

impl Store for Cache {
    fn get(&self, key: &str) -> Option<Vec<u8>> { unimplemented!("later") }
}

fn helper(x: i32) -> i32 {}

mod inner {
    pub fn f() {}
}
`;

const JAVA = `/**
 * Fetches issues and caches them.
 */
package com.example.cache;

import java.util.Map;
import static java.lang.Math.max;

/** The cache. */
public class Cache implements Store {
    public static final int MAX_SIZE = 10;
    private final String dir;

    public Cache(String dir) {
        this.dir = dir;
    }

    /** Get one. */
    public byte[] get(String key) {
        throw new UnsupportedOperationException("TODO");
    }

    public void put(String key, byte[] v) {
    }

    static class Entry {
        int size() { return 1; }
    }
}

interface Store {
    byte[] get(String key);
}

record Point(int x, int y) {}

enum Color { RED, GREEN }
`;

describe("Go outline", () => {
  it("reads the package comment, symbols, receivers, stubs and imports", async () => {
    const o = await outline(ts, "go", GO);
    assert.strictEqual(o.parser, "tree-sitter");
    assert.deepStrictEqual(o.moduleString, { text: "Package cache stores HTTP responses on disk.\n\nIt uses ETags.", closed: true, startLine: 0, endLine: 2 });
    assert.strictEqual(
      formatOutline(o, { docstrings: true }),
      [
        "imports: fmt, net/http, os",
        "L13-13 const MaxSize = 10",
        'L15-15 var defaultDir = "x"',
        "L18-20 type Cache struct",
        '    "Cache keeps entries."',
        "L22-24 type Getter interface",
        "L27-29 func New(dir string) *Cache",
        '    "New makes a cache."',
        "  L31-33 func (c *Cache) Get(key string) ([]byte, error)  [stub]",
        "  L35-36 func (c Cache) Put(key string, v []byte) error  [stub]",
      ].join("\n"),
    );
    const get = o.symbols.find((s) => s.qualname === "Cache.Get")!;
    assert.deepStrictEqual([get.kind, get.parent], ["method", "Cache"]);
    assert.strictEqual(o.symbols.find((s) => s.name === "Cache")!.kind, "class");
    assert.strictEqual(o.symbols.find((s) => s.name === "New")!.isStub, false);
  });

  it("skips build tags before the package comment and treats a TODO-only body as a stub", async () => {
    const code = "//go:build linux\n\n// Package x does y.\npackage x\n\nfunc a() {\n\t// TODO\n}\n";
    const o = await outline(ts, "go", code);
    assert.strictEqual(o.moduleString?.text, "Package x does y.");
    assert.strictEqual(o.symbols[0].isStub, true);
  });
});

describe("Rust outline", () => {
  it("reads //! docs, items, impl and trait methods, stub macros and use paths", async () => {
    const o = await outline(ts, "rust", RUST);
    assert.deepStrictEqual(o.moduleString, { text: "Fetch issues and cache them.\nSecond line.", closed: true, startLine: 0, endLine: 1 });
    assert.strictEqual(
      formatOutline(o, { docstrings: true }),
      [
        "imports: std::collections::HashMap, crate::util::{a, b}",
        "L7-7 pub const MAX: usize = 3;",
        "L10-12 pub struct Cache",
        '    "A cache."',
        "L14-14 pub enum Mode",
        "L16-18 pub trait Store",
        "  L17-17 fn get(&self, key: &str) -> Option<Vec<u8>>",
        "  L22-24 pub fn new(dir: &str) -> Self",
        '      "Make one."',
        "  L26-28 pub async fn get(&self, key: &str) -> Option<Vec<u8>>  [stub]",
        "  L32-32 fn get(&self, key: &str) -> Option<Vec<u8>>  [stub]",
        "L35-35 fn helper(x: i32) -> i32  [stub]",
        "L38-38 pub fn f()  [stub]",
      ].join("\n"),
    );
    assert.deepStrictEqual(
      o.symbols.map((s) => s.qualname),
      ["MAX", "Cache", "Mode", "Store", "Store.get", "Cache.new", "Cache.get", "Cache.get", "helper", "inner.f"],
    );
    assert.strictEqual(o.symbols.find((s) => s.qualname === "Cache.new")!.isStub, false);
  });

  it("knows panic!(\"not implemented\") is a stub and a real panic is not", async () => {
    const o = await outline(ts, "rust", 'fn a() { panic!("not implemented") }\nfn b() { panic!("bad state") }\n');
    assert.deepStrictEqual(o.symbols.map((s) => s.isStub), [true, false]);
  });
});

describe("Java outline", () => {
  it("reads the leading Javadoc, classes, members, constants, nested types and imports", async () => {
    const o = await outline(ts, "java", JAVA);
    assert.deepStrictEqual(o.moduleString, { text: "Fetches issues and caches them.", closed: true, startLine: 0, endLine: 2 });
    assert.strictEqual(
      formatOutline(o, { docstrings: true }),
      [
        "imports: java.util.Map, java.lang.Math.max",
        "L10-29 public class Cache implements Store",
        '    "The cache."',
        "  L11-11 public static final int MAX_SIZE = 10;",
        "  L14-16 public Cache(String dir)",
        "  L19-21 public byte[] get(String key)  [stub]",
        '      "Get one."',
        "  L23-24 public void put(String key, byte[] v)  [stub]",
        "  L26-28 static class Entry",
        "  L27-27 int size()",
        "L31-33 interface Store",
        "  L32-32 byte[] get(String key)",
        "L35-35 record Point(int x, int y)",
        "L37-37 enum Color",
      ].join("\n"),
    );
    assert.deepStrictEqual(
      o.symbols.map((s) => `${s.kind} ${s.qualname}`),
      [
        "class Cache",
        "constant Cache.MAX_SIZE",
        "method Cache.Cache",
        "method Cache.get",
        "method Cache.put",
        "class Cache.Entry",
        "method Cache.Entry.size",
        "type Store",
        "method Store.get",
        "class Point",
        "type Color",
      ],
    );
  });
});

describe("C-style module strings", () => {
  it("strips Rust //! and /*! markers", () => {
    assert.strictEqual(cStyleModuleString("//! Parse CSV.\n//! Report balances.\n\nuse std::io;\n")?.text, "Parse CSV.\nReport balances.");
    assert.strictEqual(cStyleModuleString("/*! Inner block doc. */\nfn main() {}\n")?.text, "Inner block doc.");
  });
});

describe("resolveImport (Go, Rust, Java)", () => {
  it("finds the package folder of a Go import of this module, never the standard library", () => {
    const files = new Set(["go.mod", "main.go", "internal/cache/cache.go", "internal/cache/cache_test.go", "internal/cache/disk.go", "fmt/fmt.go"]);
    assert.strictEqual(resolveImport("example.com/app/internal/cache", "main.go", "go", files), "internal/cache/cache.go");
    assert.strictEqual(resolveImport("fmt", "main.go", "go", files), undefined);
    assert.strictEqual(resolveImport("github.com/other/lib", "main.go", "go", files), undefined);
  });

  it("follows crate::, self:: and super:: paths in Rust", () => {
    const files = new Set(["src/main.rs", "src/util.rs", "src/net/mod.rs", "src/net/http.rs", "src/net/http/client.rs"]);
    assert.strictEqual(resolveImport("crate::util::{a, b}", "src/main.rs", "rust", files), "src/util.rs");
    assert.strictEqual(resolveImport("crate::net::http::Client", "src/main.rs", "rust", files), "src/net/http.rs");
    assert.strictEqual(resolveImport("crate::net", "src/main.rs", "rust", files), "src/net/mod.rs");
    assert.strictEqual(resolveImport("self::client::Client", "src/net/http.rs", "rust", files), "src/net/http/client.rs");
    assert.strictEqual(resolveImport("super::util", "src/net/mod.rs", "rust", files), "src/util.rs");
    assert.strictEqual(resolveImport("std::collections::HashMap", "src/main.rs", "rust", files), undefined);
  });

  it("finds Java classes under any source root, for static and wildcard imports too", () => {
    const files = new Set(["src/main/java/com/example/App.java", "src/main/java/com/example/util/Strings.java", "src/main/java/com/example/util/Dates.java"]);
    const from = "src/main/java/com/example/App.java";
    assert.strictEqual(resolveImport("com.example.util.Strings", from, "java", files), "src/main/java/com/example/util/Strings.java");
    assert.strictEqual(resolveImport("com.example.util.Strings.pad", from, "java", files), "src/main/java/com/example/util/Strings.java");
    assert.strictEqual(resolveImport("com.example.util.*", from, "java", files), "src/main/java/com/example/util/Dates.java");
    assert.strictEqual(resolveImport("java.util.Map", from, "java", files), undefined);
  });
});

describe("symbolName and findSymbol across languages", () => {
  it("normalizes Go receivers, Rust paths and modifiers", () => {
    assert.strictEqual(symbolName("func (c *Cache) Get(key string) ([]byte, error)"), "Cache.Get");
    assert.strictEqual(symbolName("Cache::get"), "Cache.get");
    assert.strictEqual(symbolName("pub async fn fetch_all(url: &str)"), "fetch_all");
    assert.strictEqual(symbolName("pub(crate) struct Cache"), "Cache");
    assert.strictEqual(symbolName("def Cache.get(self)"), "Cache.get");
    assert.strictEqual(symbolName("export const fetchAll"), "fetchAll");
  });

  it("matches graph nodes to Go and Rust methods", async () => {
    const node = (symbol: string): GraphNode => ({ id: "n", kind: "method", label: "n", symbol, description: "d", notes: [], status: "planned" });
    const go = await outline(ts, "go", GO);
    assert.strictEqual(findSymbol(node("Cache.Get"), go.symbols)?.line, 30);
    assert.strictEqual(findSymbol(node("func (c *Cache) Put()"), go.symbols)?.line, 34);
    const rust = await outline(ts, "rust", RUST);
    assert.strictEqual(findSymbol(node("Cache::new"), rust.symbols)?.qualname, "Cache.new");
  });
});
