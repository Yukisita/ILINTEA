using System.Buffers.Binary;
using SkiaSharp;

namespace ILINTEA;

public record ImageData(byte[] Bytes, string ContentType)
{
    public static string? DetectContentType(byte[] bytes)
    {
        if (bytes.Length == 0) return null;
        try
        {
            using var codec = SKCodec.Create(new MemoryStream(bytes, writable: false));
            if (codec is null) return null;
            var contentType = codec.EncodedFormat switch
            {
                SKEncodedImageFormat.Png when bytes.AsSpan().EndsWith(new byte[] { 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130 }) => "image/png",
                SKEncodedImageFormat.Jpeg when bytes.AsSpan().EndsWith(new byte[] { 255, 217 }) => "image/jpeg",
                SKEncodedImageFormat.Gif when bytes[^1] == 0x3b => "image/gif",
                SKEncodedImageFormat.Webp when bytes.Length >= 12
                    && BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(4)) == bytes.Length - 8 => "image/webp",
                _ => null
            };
            if (contentType is null) return null;

            var info = new SKImageInfo(codec.Info.Width, codec.Info.Height, SKColorType.Bgra8888, SKAlphaType.Premul);
            // Bound the decoded allocation too: a tiny compressed file can describe an enormous image.
            if (info.Width <= 0 || info.Height <= 0 || (long)info.Width * info.Height > UploadLimits.MaxFileBytes / 4)
                return null;
            using var bitmap = new SKBitmap();
            if (!bitmap.TryAllocPixels(info)) return null;

            // A decoder may recover a partial image. Accept only complete decoding of every frame.
            for (var frame = 0; frame < Math.Max(1, codec.FrameCount); frame++)
            {
                if (codec.GetFrameInfo(frame, out var frameInfo) && !frameInfo.FullyRecieved)
                    return null;
                if (codec.GetPixels(info, bitmap.GetPixels(), bitmap.RowBytes, new SKCodecOptions(frame)) != SKCodecResult.Success)
                    return null;
            }
            return contentType;
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or OverflowException)
        {
            return null;
        }
    }
}
