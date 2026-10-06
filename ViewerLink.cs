using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using Microsoft.AspNetCore.Http.Extensions;

namespace StreamPrompter;

internal static class ViewerLink
{
    public static string? Create(HttpRequest request)
    {
        var host = request.Host;
        var name = host.Host.Trim('[', ']').TrimEnd('.');
        var localOnly = name.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || name.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)
            || (IPAddress.TryParse(name, out var ip)
                && (IPAddress.IsLoopback(ip) || ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any)));

        // A LAN address or hostname used to open the editor is already suitable for sharing.
        if (localOnly)
        {
            var address = NetworkInterface.GetAllNetworkInterfaces()
                .Where(network => network.OperationalStatus == OperationalStatus.Up
                    && network.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel))
                .Select(network => network.GetIPProperties())
                // Prefer the connected LAN over VPN and virtual adapters without a gateway.
                .OrderByDescending(properties => properties.GatewayAddresses.Any(gateway =>
                    gateway.Address.AddressFamily == AddressFamily.InterNetwork && !gateway.Address.Equals(IPAddress.Any)))
                .SelectMany(properties => properties.UnicastAddresses)
                .Select(unicast => unicast.Address)
                .FirstOrDefault(address => address.AddressFamily == AddressFamily.InterNetwork
                    && !IPAddress.IsLoopback(address) && !address.Equals(IPAddress.Any)
                    && !(address.GetAddressBytes()[0] == 169 && address.GetAddressBytes()[1] == 254));
            if (address is null) return null;
            host = new HostString(address.ToString(), host.Port ?? request.HttpContext.Connection.LocalPort);
        }

        return UriHelper.BuildAbsolute(request.Scheme, host, request.PathBase, "/view/");
    }
}
