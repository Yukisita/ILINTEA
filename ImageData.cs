namespace StreamPrompter;

public record ImageData(byte[] Bytes, string ContentType)
{
    public static string? DetectContentType(byte[] bytes)
    {
        var span = bytes.AsSpan();
        if (span.StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) return "image/png";
        if (span.StartsWith(new byte[] { 255, 216, 255 })) return "image/jpeg";
        if (span.StartsWith("GIF87a"u8) || span.StartsWith("GIF89a"u8)) return "image/gif";
        if (span.Length >= 12 && span[..4].SequenceEqual("RIFF"u8) && span.Slice(8, 4).SequenceEqual("WEBP"u8)) return "image/webp";
        return null;
    }
}
