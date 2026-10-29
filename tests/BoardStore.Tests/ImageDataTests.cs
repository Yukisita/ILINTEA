using System.Buffers.Binary;
using ILINTEA;

internal static class ImageFixtures
{
    // Small, complete images, rather than the signature-only placeholders used previously.
    public static byte[] Png => Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVBhXY/jPwPCfARkAAB7zAf+x9MCaAAAAAElFTkSuQmCC");
    public static byte[] Jpeg => Convert.FromBase64String("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8rZ55LmaSaaRpZZGLvI7EszE5JJPUmiiis6fwL0OvF/7xU/xP8z//2Q==");
    public static byte[] Gif => Convert.FromHexString("47494638396101000100800000FF000000FF002C00000000010001000002024401003B");
    public static byte[] Webp => Convert.FromBase64String("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA");

    public static IEnumerable<(string Type, byte[] Bytes)> All =>
        [("image/png", Png), ("image/jpeg", Jpeg), ("image/gif", Gif), ("image/webp", Webp)];
}

internal static class ImageDataTests
{
    public static int Run()
    {
        var passed = 0;
        Check("Complete PNG, JPEG, GIF and WebP files retain their detected content types", () =>
        {
            foreach (var (type, bytes) in ImageFixtures.All) Equal(type, ImageData.DetectContentType(bytes));
            var gif87 = ImageFixtures.Gif;
            gif87[4] = (byte)'7';
            Equal("image/gif", ImageData.DetectContentType(gif87));
        });
        Check("Signatures alone, empty files and unknown formats are rejected", () =>
        {
            byte[][] invalid = [[], [137, 80, 78, 71, 13, 10, 26, 10], [255, 216, 255],
                "GIF87a"u8.ToArray(), "GIF89a"u8.ToArray(), "RIFFxxxxWEBP"u8.ToArray(), "unknown"u8.ToArray()];
            foreach (var bytes in invalid) Equal<string?>(null, ImageData.DetectContentType(bytes));
        });
        Check("Every truncation of the supported sample images is rejected", () =>
        {
            foreach (var (_, bytes) in ImageFixtures.All)
                for (var length = 0; length < bytes.Length; length++)
                    Equal<string?>(null, ImageData.DetectContentType(bytes[..length]));
        });
        Check("PNG chunk corruption, missing pixels and invalid chunk lengths are rejected", () =>
        {
            var png = ImageFixtures.Png;
            png[30] ^= 1; // Header CRC.
            Equal<string?>(null, ImageData.DetectContentType(png));
            png = ImageFixtures.Png;
            png[^20] ^= 1; // Compressed pixel data or its CRC.
            Equal<string?>(null, ImageData.DetectContentType(png));
            png = ImageFixtures.Png;
            png.AsSpan(8, 4).Fill(0xff);
            Equal<string?>(null, ImageData.DetectContentType(png));
            png = ImageFixtures.Png;
            Equal<string?>(null, ImageData.DetectContentType([.. png[..33], .. png[^12..]]));
        });
        Check("Corrupt PNG pixels are rejected even when the chunk CRC is valid", () =>
        {
            var png = ImageFixtures.Png;
            var chunk = png.AsSpan().IndexOf("IDAT"u8);
            png[chunk + 4] = 0; // Invalid zlib header; leave the PNG structure intact.
            RepairPngCrc(png, chunk);
            Equal<string?>(null, ImageData.DetectContentType(png));
        });
        Check("Images with excessive decoded dimensions are rejected before allocating pixels", () =>
        {
            var png = ImageFixtures.Png;
            BinaryPrimitives.WriteUInt32BigEndian(png.AsSpan(16), 32768);
            BinaryPrimitives.WriteUInt32BigEndian(png.AsSpan(20), 32768);
            RepairPngCrc(png, 12);
            Equal<string?>(null, ImageData.DetectContentType(png));
        });
        Check("GIF animations require complete frame blocks", () =>
        {
            var gif = ImageFixtures.Gif;
            byte[] animation = [.. gif[..^1], .. gif[19..]];
            Equal("image/gif", ImageData.DetectContentType(animation));
            animation[^5] = 255; // Sub-block length runs past the frame data.
            Equal<string?>(null, ImageData.DetectContentType(animation));
        });
        Check("Corrupt pixels in a later GIF frame are rejected", () =>
        {
            var gif = ImageFixtures.Gif;
            byte[] animation = [.. gif[..^1], .. gif[19..]];
            animation[^4] = 0xff; // Invalid LZW codes in the second frame, with complete blocks.
            animation[^3] = 0xff;
            Equal<string?>(null, ImageData.DetectContentType(animation));
        });
        Check("WebP container sizes and frame payloads are checked", () =>
        {
            var webp = ImageFixtures.Webp;
            webp[4]++;
            Equal<string?>(null, ImageData.DetectContentType(webp));
            webp = ImageFixtures.Webp;
            webp[16] = 255;
            Equal<string?>(null, ImageData.DetectContentType(webp));
            webp = ImageFixtures.Webp;
            byte[] extended = [.. webp[..12], .. "VP8X"u8, 10, 0, 0, 0, .. new byte[10], .. webp[12..]];
            BinaryPrimitives.WriteUInt32LittleEndian(extended.AsSpan(4), (uint)extended.Length - 8);
            Equal("image/webp", ImageData.DetectContentType(extended));
            byte[] frame = [.. "ANMF"u8, 46, 0, 0, 0, .. new byte[16], .. webp[12..]];
            byte[] animation = [.. extended[..30], .. "ANIM"u8, 6, 0, 0, 0, .. new byte[6], .. frame];
            animation[20] = 2; // VP8X animation flag.
            BinaryPrimitives.WriteUInt32LittleEndian(animation.AsSpan(4), (uint)animation.Length - 8);
            Equal("image/webp", ImageData.DetectContentType(animation));
            animation[^1] = 0; // A truncated inner chunk, even with a matching outer size.
            Array.Resize(ref animation, animation.Length - 2);
            BinaryPrimitives.WriteUInt32LittleEndian(animation.AsSpan(4), (uint)animation.Length - 8);
            Equal<string?>(null, ImageData.DetectContentType(animation));
        });
        Check("Random malformed inputs do not throw during image validation", () =>
        {
            var random = new Random(1234);
            foreach (var (_, fixture) in ImageFixtures.All)
                for (var i = 0; i < 100; i++)
                {
                    var bytes = fixture.ToArray();
                    random.NextBytes(bytes.AsSpan(random.Next(bytes.Length)));
                    _ = ImageData.DetectContentType(bytes);
                }
        });
        return passed;

        void Check(string name, Action test)
        {
            test();
            passed++;
            Console.WriteLine($"PASS: {name}");
        }
    }

    private static void RepairPngCrc(byte[] png, int typeOffset)
    {
        var length = (int)BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(typeOffset - 4));
        var crc = uint.MaxValue;
        foreach (var value in png.AsSpan(typeOffset, length + 4))
        {
            crc ^= value;
            for (var bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) == 0 ? 0 : 0xedb88320u);
        }
        BinaryPrimitives.WriteUInt32BigEndian(png.AsSpan(typeOffset + length + 4), ~crc);
    }

    private static void Equal<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new InvalidOperationException($"Expected {expected}; actual {actual}");
    }
}
