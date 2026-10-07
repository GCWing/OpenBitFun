use std::io::{self, Cursor, Read, Write};

use openbitfun_tool_call_jsonrepair::{
    jsonrepair, jsonrepair_reader_to_writer, JsonRepairStreamError,
};

#[test]
fn repairs_reader_to_writer() {
    let mut input = Cursor::new("{name: 'Ada', active: True}");
    let mut output = Vec::new();

    jsonrepair_reader_to_writer(&mut input, &mut output).unwrap();

    assert_eq!(
        String::from_utf8(output).unwrap(),
        r#"{"name": "Ada", "active": true}"#
    );
}

#[test]
fn matches_string_api_for_file_sized_input() {
    let mut lines = Vec::new();
    for index in 0..2048 {
        lines.push(format!("{{id:{index}, name:'item-{index}', ok: True,}}"));
    }
    let input = lines.join("\n");

    let mut reader = ChunkedReader::new(input.as_bytes(), 17);
    let mut output = Vec::new();

    jsonrepair_reader_to_writer(&mut reader, &mut output).unwrap();

    let streamed = String::from_utf8(output).unwrap();
    assert_eq!(streamed, jsonrepair(&input).unwrap());
    serde_json::from_str::<serde_json::Value>(&streamed).unwrap();
}

#[test]
fn chunk_boundary_cases_match_string_api() {
    let cases = [
        r#"{"text":"hello\nworld","quote":"a\"b"}"#,
        "{\n// comment\nname:'Ada', active: True\n}",
        "[.5, 2e, +.5, -Infinity]",
        "{items:[1,2,], name:'Ada',}",
        "{name:'Ada', nested:{items:[1,2,3}",
        "{\"a\":1}\n{\"b\":2}\n[3,4]",
    ];

    for input in cases {
        let expected = jsonrepair(input).unwrap();
        for chunk_size in [1, 2, 3, 5, 8, 13] {
            let mut reader = ChunkedReader::new(input.as_bytes(), chunk_size);
            let mut output = Vec::new();

            jsonrepair_reader_to_writer(&mut reader, &mut output).unwrap();

            assert_eq!(
                String::from_utf8(output).unwrap(),
                expected,
                "input {input:?} with chunk size {chunk_size}",
            );
        }
    }
}

#[test]
fn repairs_truncated_llm_url_across_reader_chunks() {
    let input = r##"{"content":"# Heading\nhttps:/"##;
    let expected = r##"{"content":"# Heading\nhttps:/"}"##;
    for chunk_size in [1, 2, 3, 5] {
        let mut output = Vec::new();
        jsonrepair_reader_to_writer(
            ChunkedReader::new(input.as_bytes(), chunk_size),
            &mut output,
        )
        .unwrap();
        assert_eq!(output, expected.as_bytes(), "chunk size {chunk_size}");
    }
}

#[test]
fn preserves_repair_errors_without_partial_output() {
    for input in [&br#""\u00""#[..], &b"[\x0c"[..], &br#""\udfff""#[..]] {
        let mut output = Vec::new();
        let err = jsonrepair_reader_to_writer(Cursor::new(input), &mut output).unwrap_err();

        assert!(matches!(err, JsonRepairStreamError::Repair(_)));
        assert!(output.is_empty());
    }
}

#[test]
fn reports_read_errors() {
    let mut output = Vec::new();
    let err = jsonrepair_reader_to_writer(FailingReader, &mut output).unwrap_err();

    assert!(matches!(err, JsonRepairStreamError::Read(_)));
    assert!(output.is_empty());
}

#[test]
fn reports_write_errors() {
    let input = Cursor::new("{name: 'Ada'}");
    let mut output = FailingWriter;

    let err = jsonrepair_reader_to_writer(input, &mut output).unwrap_err();

    assert!(matches!(err, JsonRepairStreamError::Write(_)));
}

struct ChunkedReader<'a> {
    input: &'a [u8],
    chunk_size: usize,
    offset: usize,
}

impl<'a> ChunkedReader<'a> {
    fn new(input: &'a [u8], chunk_size: usize) -> Self {
        Self {
            input,
            chunk_size,
            offset: 0,
        }
    }
}

impl Read for ChunkedReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.offset >= self.input.len() {
            return Ok(0);
        }

        let len = self
            .chunk_size
            .min(buf.len())
            .min(self.input.len() - self.offset);
        buf[..len].copy_from_slice(&self.input[self.offset..self.offset + len]);
        self.offset += len;
        Ok(len)
    }
}

struct FailingReader;

impl Read for FailingReader {
    fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::Other, "source closed"))
    }
}

struct FailingWriter;

impl Write for FailingWriter {
    fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::Other, "destination closed"))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
