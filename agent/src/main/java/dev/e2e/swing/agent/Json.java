package dev.e2e.swing.agent;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON reading and writing for the agent's protocol.
 *
 * <p>Parsed values are {@code Map<String, Object>}, {@code List<Object>}, {@code String},
 * {@code Long} (integers), {@code Double} (other numbers), {@code Boolean}, or {@code null}.
 */
final class Json {
    /** Stops an unauthenticated client from overflowing the stack with deep nesting. */
    private static final int MAX_DEPTH = 32;

    private Json() {
    }

    /** Thrown for invalid JSON. The message never quotes the input, which may contain the token. */
    static final class ParseException extends Exception {
        private static final long serialVersionUID = 1L;

        private ParseException(String message) {
            super(message);
        }
    }

    /** Parses the whole string as one JSON value. */
    static Object parse(String text) throws ParseException {
        return new Parser(text).parseDocument();
    }

    /**
     * Writes a value as one line of JSON. Newlines in strings are always escaped, so the output
     * never contains a raw newline.
     *
     * @throws IllegalArgumentException if JSON cannot represent the value: a non-finite number, a
     *     non-string key, or an unsupported type
     */
    static String write(Object value) {
        var out = new StringBuilder();
        writeValue(out, value);
        return out.toString();
    }

    private static void writeValue(StringBuilder out, Object value) {
        if (value == null || value instanceof Boolean) {
            out.append(value);
        } else if (value instanceof String string) {
            writeString(out, string);
        } else if (value instanceof Number number) {
            writeNumber(out, number);
        } else if (value instanceof Map<?, ?> map) {
            writeObject(out, map);
        } else if (value instanceof List<?> list) {
            writeArray(out, list);
        } else {
            throw new IllegalArgumentException("unsupported JSON type: " + value.getClass().getName());
        }
    }

    private static void writeNumber(StringBuilder out, Number number) {
        double asDouble = number.doubleValue();
        if (Double.isNaN(asDouble) || Double.isInfinite(asDouble)) {
            throw new IllegalArgumentException("JSON numbers must be finite");
        }
        out.append(number);
    }

    private static void writeObject(StringBuilder out, Map<?, ?> map) {
        out.append('{');
        var first = true;
        for (var entry : map.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw new IllegalArgumentException("JSON object keys must be strings");
            }
            if (!first) {
                out.append(',');
            }
            first = false;
            writeString(out, key);
            out.append(':');
            writeValue(out, entry.getValue());
        }
        out.append('}');
    }

    private static void writeArray(StringBuilder out, List<?> list) {
        out.append('[');
        var first = true;
        for (var item : list) {
            if (!first) {
                out.append(',');
            }
            first = false;
            writeValue(out, item);
        }
        out.append(']');
    }

    private static void writeString(StringBuilder out, String string) {
        out.append('"');
        for (int i = 0; i < string.length(); i++) {
            char c = string.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }

    private static final class Parser {
        private final String text;
        private int pos;
        private int depth;

        Parser(String text) {
            this.text = text;
        }

        Object parseDocument() throws ParseException {
            Object value = parseValue();
            skipWhitespace();
            if (pos != text.length()) {
                throw error("unexpected trailing content");
            }
            return value;
        }

        private Object parseValue() throws ParseException {
            skipWhitespace();
            if (pos == text.length()) {
                throw error("unexpected end of input");
            }
            char c = text.charAt(pos);
            return switch (c) {
                case '{' -> parseObject();
                case '[' -> parseArray();
                case '"' -> parseString();
                case 't' -> parseLiteral("true", Boolean.TRUE);
                case 'f' -> parseLiteral("false", Boolean.FALSE);
                case 'n' -> parseLiteral("null", null);
                default -> {
                    if (c == '-' || isDigit(c)) {
                        yield parseNumber();
                    }
                    throw error("unexpected character");
                }
            };
        }

        private Map<String, Object> parseObject() throws ParseException {
            enterContainer();
            pos++;
            var object = new LinkedHashMap<String, Object>();
            skipWhitespace();
            if (consumeIf('}')) {
                depth--;
                return object;
            }
            while (true) {
                skipWhitespace();
                if (pos == text.length() || text.charAt(pos) != '"') {
                    throw error("expected an object key");
                }
                String key = parseString();
                skipWhitespace();
                if (!consumeIf(':')) {
                    throw error("expected ':'");
                }
                object.put(key, parseValue());
                skipWhitespace();
                if (consumeIf('}')) {
                    depth--;
                    return object;
                }
                if (!consumeIf(',')) {
                    throw error("expected ',' or '}'");
                }
            }
        }

        private List<Object> parseArray() throws ParseException {
            enterContainer();
            pos++;
            var array = new ArrayList<Object>();
            skipWhitespace();
            if (consumeIf(']')) {
                depth--;
                return array;
            }
            while (true) {
                array.add(parseValue());
                skipWhitespace();
                if (consumeIf(']')) {
                    depth--;
                    return array;
                }
                if (!consumeIf(',')) {
                    throw error("expected ',' or ']'");
                }
            }
        }

        private void enterContainer() throws ParseException {
            if (++depth > MAX_DEPTH) {
                throw error("nesting too deep");
            }
        }

        private String parseString() throws ParseException {
            pos++;
            var out = new StringBuilder();
            while (pos < text.length()) {
                char c = text.charAt(pos++);
                if (c == '"') {
                    return out.toString();
                }
                if (c < 0x20) {
                    throw error("unescaped control character in string");
                }
                out.append(c == '\\' ? parseEscape() : c);
            }
            throw error("unterminated string");
        }

        private char parseEscape() throws ParseException {
            if (pos == text.length()) {
                throw error("unterminated string");
            }
            char c = text.charAt(pos++);
            return switch (c) {
                case '"', '\\', '/' -> c;
                case 'b' -> '\b';
                case 'f' -> '\f';
                case 'n' -> '\n';
                case 'r' -> '\r';
                case 't' -> '\t';
                case 'u' -> parseUnicodeEscape();
                default -> throw error("invalid escape");
            };
        }

        private char parseUnicodeEscape() throws ParseException {
            if (pos + 4 > text.length()) {
                throw error("invalid unicode escape");
            }
            int code = 0;
            for (int i = 0; i < 4; i++) {
                int digit = hexValue(text.charAt(pos++));
                if (digit < 0) {
                    throw error("invalid unicode escape");
                }
                code = code * 16 + digit;
            }
            return (char) code;
        }

        private Number parseNumber() throws ParseException {
            int start = pos;
            consumeIf('-');
            if (!consumeIf('0')) {
                requireDigits();
            }
            boolean integer = true;
            if (consumeIf('.')) {
                integer = false;
                requireDigits();
            }
            if (consumeIf('e') || consumeIf('E')) {
                integer = false;
                if (!consumeIf('+')) {
                    consumeIf('-');
                }
                requireDigits();
            }
            String literal = text.substring(start, pos);
            if (integer) {
                try {
                    return Long.valueOf(literal);
                } catch (NumberFormatException tooLarge) {
                    // An integer too large for a long falls through and is read as a Double.
                }
            }
            double value = Double.parseDouble(literal);
            if (Double.isInfinite(value)) {
                throw error("number out of range");
            }
            return value;
        }

        private void requireDigits() throws ParseException {
            if (pos == text.length() || !isDigit(text.charAt(pos))) {
                throw error("expected a digit");
            }
            while (pos < text.length() && isDigit(text.charAt(pos))) {
                pos++;
            }
        }

        private Object parseLiteral(String literal, Object value) throws ParseException {
            if (!text.startsWith(literal, pos)) {
                throw error("unexpected character");
            }
            pos += literal.length();
            return value;
        }

        private boolean consumeIf(char expected) {
            if (pos < text.length() && text.charAt(pos) == expected) {
                pos++;
                return true;
            }
            return false;
        }

        private void skipWhitespace() {
            while (pos < text.length()) {
                char c = text.charAt(pos);
                if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
                    return;
                }
                pos++;
            }
        }

        private ParseException error(String reason) {
            return new ParseException(reason + " at offset " + pos);
        }

        private static boolean isDigit(char c) {
            return c >= '0' && c <= '9';
        }

        private static int hexValue(char c) {
            if (isDigit(c)) {
                return c - '0';
            }
            if (c >= 'a' && c <= 'f') {
                return c - 'a' + 10;
            }
            if (c >= 'A' && c <= 'F') {
                return c - 'A' + 10;
            }
            return -1;
        }
    }
}
