use std::io::{self, Write};

use openbitfun_tool_call_jsonrepair::{jsonrepair_to_writer, JsonRepairWriteError};

#[test]
fn repairs_into_writer() {
    let mut output = Vec::new();

    jsonrepair_to_writer("{name: 'Ada', active: True}", &mut output).unwrap();

    assert_eq!(
        String::from_utf8(output).unwrap(),
        r#"{"name": "Ada", "active": true}"#
    );
}

#[test]
fn preserves_repair_errors() {
    let mut output = Vec::new();
    let err = jsonrepair_to_writer(r#""\u00""#, &mut output).unwrap_err();

    assert!(matches!(err, JsonRepairWriteError::Repair(_)));
    assert!(output.is_empty());
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

#[test]
fn reports_writer_errors() {
    let mut output = FailingWriter;
    let err = jsonrepair_to_writer("{name: 'Ada'}", &mut output).unwrap_err();

    assert!(matches!(err, JsonRepairWriteError::Write(_)));
}
