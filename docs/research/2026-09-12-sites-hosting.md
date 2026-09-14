# Sites üzerinde oyunun tamamını barındırma araştırması

12 Eylül 2026. Kullanıcı mevcut çok oyunculu oyunu, botları ve seyircileri koruyarak tamamının Sites üzerinde çalışmasını araştırmamızı istedi. Araştırma sonrasında kullanıcı tarayıcı host modelini seçti; Sites kaydı oluşturuldu, harici hizmet satın alınmadı. Dağıtım durumu ayrı kabul kaydında tutulur.

## İlk araştırma sonucu

Three.js/React arayüzü Sites'ın statik barındırmasına uygundur. Mevcut Node.js sunucusu ise doğrudan paketlenip çalıştırılamaz. Sites sunuculu dağıtım sözleşmesi Cloudflare Worker uyumlu, varsayılan `fetch(request, env, ctx)` dışa aktarımı bekler; mevcut sunucu `node:http.createServer`, Express, Socket.IO, werift UDP bağlantıları ve bellek içindeki odaları sürekli ilerleten bir zamanlayıcı kullanır.

Tamamını Sites'ta tutarken sunucu otoritesini korumak için her maçın tüm bağlantılarının tek bir koordinatörde birleşmesi gerekir. Cloudflare bunu Durable Objects ile çözer. İncelenen mevcut Sites becerileri ve araçları D1/R2 bağlantılarını belgeler; Durable Object tanımlama, binding ekleme veya migration sağlama yolu bulamadım. Bu, Cloudflare'ın özelliği desteklemediği anlamına gelmez; Sites üzerinden kullanılabilirliği doğrulanmış değildir. Mevcut kanıtla tam çalışan Sites dağıtımı sözü verilemez.

## Gerekli değişiklikler ve kabul kapısı

Sites Durable Objects veya eşdeğer tekil oda koordinasyonu sunarsa, oda başına bir koordinatör ve WebSocket bağlantısı kullanılabilir. Paylaşılan fizik, dövüş, bot kararları ve istemci çizimi korunur. Socket.IO/WebRTC taşıma katmanı Worker uyumlu WebSocket taşımasıyla değiştirilir; oda üyeliği, hazır olma, katılma, yeniden bağlanma, sıralama, olay kimlikleri ve snapshot zamanlaması yeniden doğrulanır. 60 Hz maç döngüsü, 8 dövüşçü ve 8 seyirci yüküyle gerçek barındırma ortamında ölçülmelidir. Host seyirci olabilmeli; host ayrıldığında odadaki diğer insanlar devam edebilmelidir.

Bir Worker'ın modül seviyesindeki Map nesnesi bu koordinasyonun yerine geçmez: farklı istekler farklı örneklerde çalışabilir. D1'i her fizik adımında okuyup yazmak mevcut düşük gecikmeli mimariye doğrudan karşılık değildir; ölçüm olmadan uygun kabul edilmemelidir. D1 maç geçmişi veya kalıcı skor için uygundur, fakat buna şu an ihtiyaç yoktur.

Simülasyonu tarayıcıya taşımak botlarla tek kişilik oyun için mümkündür. Çok oyunculu otoriteyi oda sahibinin tarayıcısına taşımak ise hile güveni, host ayrılması ve internet üzerinden WebRTC erişilebilirliği davranışlarını değiştirir. Bunlar mevcut isteğe eşdeğer bir yayın diye sunulmamalıdır.

## Ücret

Resmî Sites belgesi, hizmetin Plus, Pro, Business, Enterprise ve Edu planlarında public beta olduğunu ve plan bazlı toplam kullanım limitleri bulunduğunu söylüyor. Limite ulaşmak yeni site oluşturmayı, depolama eklemeyi veya yüksek kullanım alan bir siteyi herkese açık tutmayı engelleyebilir. İncelenen resmî sayfa ayrıca bir barındırma birim fiyatı ya da sınırsız ücretsiz kullanım garantisi vermiyor. 12 Eylül canlı kontrolünde OpenAI Yardım Merkezi açıkça beta kullanımının plan limitleri içinde dahil olduğunu doğruladı. Bu sınırlar içinde ayrıca Sites yayın ücreti yok; sınırsız veya kalıcı ücretsiz kullanım garantisi verilmez. Codex geliştirme kullanımı ile yayımlanan oyunun barındırma kullanımı ayrı değerlendirilmelidir; Cloudflare'ın doğrudan fiyatları Sites faturası gibi gösterilmemelidir.

## Kaynaklar

- [Sites: desteklenen bağlantılar, beta ve kullanım limitleri](https://learn.chatgpt.com/docs/sites)
- [Cloudflare: Worker WebSockets ve ortak koordinasyon](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
- [Cloudflare: Durable Objects, oda başına koordinasyon](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- Yerel Sites eklentisi 0.1.62: `sites-hosting/SKILL.md`, `sites-building/SKILL.md`, `references/starter-capabilities.md`, `references/persistence-and-storage.md` ve oturumdaki Sites araç sözleşmeleri.
- Oyun kaynakları: `src/server/network/createGameServer.ts`, `src/server/rooms/roomManager.ts`, `src/server/network/gameplayTransport/WeriftServerPeer.ts`.


## Kullanıcının son kararı ve uygulama

Kullanıcı oda sahibinin tarayıcısını host yapmayı açıkça seçti. Ortak RoomManager, fizik ve bot kodu tarayıcıda çalışacak şekilde taşındı; WebRTC doğrudan Wi-Fi/LAN bağlantısı kuruyor. Sites D1 yalnız 90 saniyelik oda kaydı ve 30 saniyelik bağlantı teklif/yanıtlarını tutuyor; oyun kareleri D1'e yazılmıyor. Host sekmesinin kapanması odayı sonlandırır; Node sunucudaki host devrini bu mod için vaat etmiyoruz. Herkese açık site bağlantısına kullanıcı ayrıca onay verdi. Aynı ağ gereksinimi sürüyor.

[OpenAI Yardım Merkezi: beta kullanımının plana dahil olması](https://help.openai.com/en/articles/20001339), 12 Eylül 2026 canlı kontrol. Kullanıcı ücret sorusunu yinelediğinde dağıtım kontrol için bekletildi; bu resmî kapsam açıklanarak devam edildi. Ücretli harici hizmet sağlanmadı.
