use crate::models::{Device, DiscoveryMessage};
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;

const DISCOVERY_PORT: u16 = 7890;
const BROADCAST_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3);
const ANNOUNCE_REPLY_THROTTLE: std::time::Duration = std::time::Duration::from_secs(2);
const DEVICE_TIMEOUT_SECS: i64 = 45;
const FORGOTTEN_DEVICE_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

pub struct DiscoveryService {
    device_id: String,
    device_name: Arc<RwLock<String>>,
    device_type: String,
    ip: String,
    port: u16,
    devices: Arc<RwLock<HashMap<String, Device>>>,
    device_last_seen: Arc<RwLock<HashMap<String, Instant>>>,
    forgotten_devices: Arc<RwLock<HashMap<String, Instant>>>,
    recv_socket: Arc<UdpSocket>,
    send_socket: Arc<UdpSocket>,
    broadcast_addrs: Arc<Vec<SocketAddr>>,
}

impl DiscoveryService {
    pub async fn new(port: u16, device_id: String, device_name: String) -> anyhow::Result<Self> {
        let device_type = current_device_type().to_string();
        let ip = get_local_ip();

        let recv_socket = create_discovery_recv_socket()?;
        let send_socket = UdpSocket::bind(("0.0.0.0", 0))?;
        send_socket.set_broadcast(true)?;
        send_socket.set_nonblocking(true)?;
        let broadcast_addrs = Arc::new(discovery_broadcast_addrs());

        Ok(Self {
            device_id,
            device_name: Arc::new(RwLock::new(device_name)),
            device_type,
            ip,
            port,
            devices: Arc::new(RwLock::new(HashMap::new())),
            device_last_seen: Arc::new(RwLock::new(HashMap::new())),
            forgotten_devices: Arc::new(RwLock::new(HashMap::new())),
            recv_socket: Arc::new(recv_socket),
            send_socket: Arc::new(send_socket),
            broadcast_addrs,
        })
    }

    pub fn get_device_id(&self) -> &str {
        &self.device_id
    }

    pub fn get_device_name(&self) -> String {
        self.device_name
            .try_read()
            .map(|name| name.clone())
            .unwrap_or_default()
    }

    pub async fn set_device_name(&self, name: String) {
        let mut device_name = self.device_name.write().await;
        *device_name = name;
    }

    pub fn get_ip(&self) -> &str {
        &self.ip
    }

    pub fn get_port(&self) -> u16 {
        self.port
    }

    pub async fn get_devices(&self) -> Vec<Device> {
        let now = Instant::now();
        let mut forgotten_devices = self.forgotten_devices.write().await;
        forgotten_devices
            .retain(|_, forgotten_at| now.duration_since(*forgotten_at) < FORGOTTEN_DEVICE_TTL);
        let forgotten_ids: Vec<String> = forgotten_devices.keys().cloned().collect();
        drop(forgotten_devices);

        let devices = self.devices.read().await;
        let last_seen_times = self.device_last_seen.read().await;

        devices
            .values()
            .filter(|d| !forgotten_ids.iter().any(|id| id == &d.device_id))
            .map(|d| {
                let is_online = last_seen_times
                    .get(&d.device_id)
                    .map(|last_seen| {
                        let elapsed = now.duration_since(*last_seen);
                        elapsed.as_secs() < DEVICE_TIMEOUT_SECS as u64
                    })
                    .unwrap_or(false);

                Device {
                    is_online,
                    ..d.clone()
                }
            })
            .collect()
    }

    pub async fn forget_device(&self, device_id: &str) -> anyhow::Result<()> {
        self.devices.write().await.remove(device_id);
        self.device_last_seen.write().await.remove(device_id);
        self.forgotten_devices
            .write()
            .await
            .insert(device_id.to_string(), Instant::now());
        Ok(())
    }

    pub async fn toggle_favorite(&self, device_id: &str) -> anyhow::Result<()> {
        let mut devices = self.devices.write().await;
        if let Some(device) = devices.get_mut(device_id) {
            device.is_favorite = !device.is_favorite;
        }
        Ok(())
    }

    pub async fn announce_once(&self) -> anyhow::Result<()> {
        self.broadcast("device_announce").await
    }

    pub async fn announce_offline(&self) -> anyhow::Result<()> {
        self.broadcast("device_offline").await
    }

    async fn broadcast(&self, msg_type: &str) -> anyhow::Result<()> {
        let msg = DiscoveryMessage {
            msg_type: msg_type.to_string(),
            device_id: self.device_id.clone(),
            device_name: self.device_name.read().await.clone(),
            device_type: self.device_type.clone(),
            ip: self.ip.clone(),
            port: self.port,
            timestamp: chrono::Utc::now().timestamp(),
        };
        let data = serde_json::to_vec(&msg)?;

        for broadcast_addr in self.broadcast_addrs.iter() {
            if let Err(e) = self.send_socket.send_to(&data, broadcast_addr) {
                eprintln!("Broadcast error to {}: {}", broadcast_addr, e);
            }
        }

        Ok(())
    }

    pub async fn start(&self) -> anyhow::Result<()> {
        let send_socket_clone = self.send_socket.clone();
        let broadcast_addrs = self.broadcast_addrs.clone();
        let device_id = self.device_id.clone();
        let device_name_clone = self.device_name.clone();
        let device_type = self.device_type.clone();
        let ip = self.ip.clone();
        let port = self.port;

        tokio::spawn(async move {
            loop {
                let name = device_name_clone.read().await.clone();

                let broadcast_msg = DiscoveryMessage {
                    msg_type: "device_announce".to_string(),
                    device_id: device_id.clone(),
                    device_name: name,
                    device_type: device_type.clone(),
                    ip: ip.clone(),
                    port,
                    timestamp: chrono::Utc::now().timestamp(),
                };

                if let Ok(broadcast_data) = serde_json::to_vec(&broadcast_msg) {
                    for broadcast_addr in broadcast_addrs.iter() {
                        if let Err(e) = send_socket_clone.send_to(&broadcast_data, broadcast_addr) {
                            eprintln!("Broadcast error to {}: {}", broadcast_addr, e);
                        }
                    }
                }

                tokio::time::sleep(BROADCAST_INTERVAL).await;
            }
        });

        let recv_socket_clone = self.recv_socket.clone();
        let reply_socket_clone = self.send_socket.clone();
        let devices_clone = self.devices.clone();
        let last_seen_clone = self.device_last_seen.clone();
        let forgotten_devices_clone = self.forgotten_devices.clone();
        let self_device_id = self.device_id.clone();
        let reply_device_name = self.device_name.clone();
        let reply_device_type = self.device_type.clone();
        let reply_ip = self.ip.clone();
        let reply_port = self.port;

        tokio::spawn(async move {
            let mut buf = [0u8; 4096];

            loop {
                match recv_socket_clone.recv_from(&mut buf) {
                    Ok((len, addr)) => {
                        if let Ok(msg) = serde_json::from_slice::<DiscoveryMessage>(&buf[..len]) {
                            if msg.device_id == self_device_id {
                                continue;
                            }

                            if msg.msg_type == "device_offline" {
                                let mut last_seen = last_seen_clone.write().await;
                                last_seen.remove(&msg.device_id);
                                continue;
                            }

                            if msg.msg_type == "device_announce" {
                                let now = Instant::now();
                                let mut forgotten_devices = forgotten_devices_clone.write().await;
                                if let Some(forgotten_at) = forgotten_devices.get(&msg.device_id) {
                                    if now.duration_since(*forgotten_at) < FORGOTTEN_DEVICE_TTL {
                                        continue;
                                    }
                                }
                                forgotten_devices.remove(&msg.device_id);
                                drop(forgotten_devices);

                                println!(
                                    "Discovered device: {} at {} from {}",
                                    msg.device_name, msg.ip, addr
                                );

                                let device = Device {
                                    device_id: msg.device_id.clone(),
                                    device_name: msg.device_name,
                                    device_type: msg.device_type,
                                    ip: peer_ip(&msg.ip, addr),
                                    port: msg.port,
                                    last_seen: msg.timestamp,
                                    is_online: true,
                                    alias: None,
                                    is_favorite: false,
                                };

                                let mut devices = devices_clone.write().await;
                                devices.insert(msg.device_id.clone(), device);

                                let mut last_seen = last_seen_clone.write().await;
                                let should_reply = last_seen
                                    .get(&msg.device_id)
                                    .map(|last_seen| {
                                        now.duration_since(*last_seen) >= ANNOUNCE_REPLY_THROTTLE
                                    })
                                    .unwrap_or(true);
                                last_seen.insert(msg.device_id, now);
                                drop(last_seen);

                                if should_reply {
                                    let reply_msg = DiscoveryMessage {
                                        msg_type: "device_announce".to_string(),
                                        device_id: self_device_id.clone(),
                                        device_name: reply_device_name.read().await.clone(),
                                        device_type: reply_device_type.clone(),
                                        ip: reply_ip.clone(),
                                        port: reply_port,
                                        timestamp: chrono::Utc::now().timestamp(),
                                    };

                                    if let Ok(reply_data) = serde_json::to_vec(&reply_msg) {
                                        let reply_addr = SocketAddr::new(addr.ip(), DISCOVERY_PORT);
                                        if let Err(e) =
                                            reply_socket_clone.send_to(&reply_data, reply_addr)
                                        {
                                            eprintln!(
                                                "Discovery reply error to {}: {}",
                                                reply_addr, e
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        if e.kind() != std::io::ErrorKind::WouldBlock {
                            eprintln!("Receive error: {}", e);
                        }
                    }
                }

                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        });

        Ok(())
    }
}

fn get_local_ip() -> String {
    match local_ip_address::local_ip() {
        Ok(ip) => ip.to_string(),
        Err(e) => {
            eprintln!("Failed to get local IP, using 0.0.0.0: {}", e);
            "0.0.0.0".to_string()
        }
    }
}

fn create_discovery_recv_socket() -> anyhow::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;

    #[cfg(unix)]
    socket.set_reuse_port(true).ok();

    socket.bind(&SocketAddr::from(([0, 0, 0, 0], DISCOVERY_PORT)).into())?;
    let socket: UdpSocket = socket.into();
    socket.set_broadcast(true)?;
    socket.set_nonblocking(true)?;
    Ok(socket)
}

fn discovery_broadcast_addrs() -> Vec<SocketAddr> {
    let mut addrs = vec![SocketAddr::from(([255, 255, 255, 255], DISCOVERY_PORT))];

    if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
        for (name, ip) in interfaces {
            if is_virtual_or_cellular_interface(&name) {
                continue;
            }

            if let IpAddr::V4(ipv4) = ip {
                if let Some(broadcast) = class_c_broadcast(ipv4) {
                    let addr = SocketAddr::from((broadcast, DISCOVERY_PORT));
                    if !addrs.contains(&addr) {
                        addrs.push(addr);
                    }
                }
            }
        }
    }

    addrs
}

fn is_virtual_or_cellular_interface(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    ["tun", "tap", "vpn", "rmnet", "ccmni", "pdp", "utun", "lo"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

fn class_c_broadcast(ip: Ipv4Addr) -> Option<Ipv4Addr> {
    if ip.is_loopback() || ip.is_unspecified() || ip.octets()[0] == 169 || !is_private_lan_ip(ip) {
        return None;
    }

    let [a, b, c, _] = ip.octets();
    Some(Ipv4Addr::new(a, b, c, 255))
}

fn is_private_lan_ip(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
}

fn peer_ip(advertised_ip: &str, addr: SocketAddr) -> String {
    if !addr.ip().is_unspecified() {
        addr.ip().to_string()
    } else if advertised_ip.is_empty() {
        "0.0.0.0".to_string()
    } else {
        advertised_ip.to_string()
    }
}

fn current_device_type() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(windows) {
        "windows"
    } else {
        "desktop"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_type_is_supported_value() {
        assert!(matches!(
            current_device_type(),
            "android" | "windows" | "desktop"
        ));
    }

    #[test]
    fn peer_ip_falls_back_to_packet_source() {
        let addr: SocketAddr = "192.168.1.7:7890".parse().unwrap();
        assert_eq!(peer_ip("0.0.0.0", addr), "192.168.1.7");
        assert_eq!(peer_ip("", addr), "192.168.1.7");
        assert_eq!(peer_ip("192.168.1.8", addr), "192.168.1.7");
    }

    #[test]
    fn class_c_broadcast_skips_invalid_addresses() {
        assert_eq!(
            class_c_broadcast(Ipv4Addr::new(192, 168, 1, 23)),
            Some(Ipv4Addr::new(192, 168, 1, 255))
        );
        assert_eq!(
            class_c_broadcast(Ipv4Addr::new(10, 130, 168, 225)),
            Some(Ipv4Addr::new(10, 130, 168, 255))
        );
        assert_eq!(class_c_broadcast(Ipv4Addr::new(127, 0, 0, 1)), None);
        assert_eq!(class_c_broadcast(Ipv4Addr::new(0, 0, 0, 0)), None);
        assert_eq!(class_c_broadcast(Ipv4Addr::new(8, 8, 8, 8)), None);
    }

    #[test]
    fn virtual_and_cellular_interfaces_are_skipped() {
        assert!(is_virtual_or_cellular_interface("tun0"));
        assert!(is_virtual_or_cellular_interface("rmnet_data5"));
        assert!(is_virtual_or_cellular_interface("lo"));
        assert!(!is_virtual_or_cellular_interface("wlan2"));
        assert!(!is_virtual_or_cellular_interface("Wi-Fi"));
    }
}
