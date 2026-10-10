using System.Text;

namespace StreamPrompter;

internal static class UploadLimits
{
    public const long MaxFileBytes = 1024L * 1024 * 1024;
    // JSON may escape each UTF-8 byte into six bytes; allow space for request metadata too.
    public const long MaxRequestBodyBytes = MaxFileBytes * 6 + 1024 * 1024;

    public static bool TextFits(string text) => Encoding.UTF8.GetByteCount(text) <= MaxFileBytes;
}
