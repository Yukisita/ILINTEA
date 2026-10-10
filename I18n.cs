using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace StreamPrompter;

internal static class I18n
{
    public const string DefaultLanguage = "ja";
    private static readonly Dictionary<string, Dictionary<string, string>> catalogs = LoadCatalogs();
    public static string Language { get; private set; } = DefaultLanguage;

    public static void SetLanguage(string? language)
    {
        var candidate = (language ?? DefaultLanguage).Replace('_', '-').ToLowerInvariant();
        Language = catalogs.ContainsKey(candidate) ? candidate
            : catalogs.ContainsKey(candidate.Split('-')[0]) ? candidate.Split('-')[0] : DefaultLanguage;
    }

    public static string Text(string key, params (string Name, object? Value)[] values)
    {
        if (!catalogs[Language].TryGetValue(key, out var text)
            && !catalogs[DefaultLanguage].TryGetValue(key, out text)) return key;
        var arguments = values.ToDictionary(value => value.Name,
            value => Convert.ToString(value.Value, CultureInfo.InvariantCulture));
        return Regex.Replace(text, @"\{([A-Za-z_]\w*)\}", match =>
            arguments.TryGetValue(match.Groups[1].Value, out var value) ? value ?? "" : match.Value);
    }

    public static object Error(string key) => new { error = Text(key), errorKey = key };

    private static Dictionary<string, Dictionary<string, string>> LoadCatalogs()
    {
        var assembly = typeof(I18n).Assembly;
        var prefix = $"{typeof(I18n).Namespace}.wwwroot.i18n.";
        var result = new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in assembly.GetManifestResourceNames()
            .Where(name => name.StartsWith(prefix) && name.EndsWith(".json")))
        {
            using var stream = assembly.GetManifestResourceStream(name)!;
            result.Add(name[prefix.Length..^5],
                JsonSerializer.Deserialize<Dictionary<string, string>>(stream) ?? throw new InvalidDataException(name));
        }
        if (!result.ContainsKey(DefaultLanguage)) throw new InvalidDataException(DefaultLanguage);
        return result;
    }
}
