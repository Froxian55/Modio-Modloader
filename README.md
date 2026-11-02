# Modio Manager

Windows için Electron, TypeScript ve React ile hazırlanmış mod.io masaüstü mod yöneticisi. Mod.io'nun resmi REST API'si kullanılır; API anahtarı ve oturum belirteci renderer/arayüz katmanına aktarılmaz.

## Gereksinimler

- Windows 10 veya üzeri
- Node.js 22 veya üzeri
- npm

## Geliştirme

PowerShell'de proje klasörünü açıp çalıştırın:

```powershell
npm.cmd install
npm.cmd run dev
```

PowerShell npm betiklerini engelliyorsa `npm` yerine `npm.cmd` kullanın.

## Windows uygulaması oluşturma

```powershell
npm.cmd run package:win
```

Kurulum paketi `release` klasörüne `Modio-Manager-Setup-2.0.0.exe` adıyla oluşturulur.

## GitHub Release olarak yayımlama

`.github/workflows/release.yml` workflow'u, `v` ile başlayan her Git etiketi gönderildiğinde Windows x64 kurulum EXE'sini oluşturur ve GitHub deposunda aynı etiket için bir Release açarak dosyayı ekler.

İlk kez yüklerken PowerShell'de proje klasöründe şu komutları çalıştırın:

```powershell
git init -b main
git remote add origin https://github.com/KULLANICI/DEPO.git
git add .
git commit -m "Initial release"
git push -u origin main
```

`KULLANICI/DEPO` kısmını kendi GitHub deponuzla değiştirin. GitHub deposu boş olmalı; Actions için depo ayarlarında workflow izinleri etkin olmalıdır.

Yayımlamak için `package.json` içindeki `version` değerini güncelledikten ve değişiklikleri `main` dalına gönderdikten sonra sürüm etiketini gönderin:

```powershell
git add .
git commit -m "Prepare v2.0.0 release"
git push origin main
git tag v2.0.0
git push origin v2.0.0
```

`main` yerine deponuzun varsayılan dal adını, sürüm örneği yerine `package.json` sürümünü kullanın. Workflow tamamlanınca EXE, GitHub deposunun **Releases** bölümünde indirmeye hazır olur. Sürüm etiketi her yayımlamada benzersiz olmalıdır.

## Özellikler

- Mod.io e-posta kodu ile giriş ve abonelikleri eşitleme
- Abone olunan oyunlar için görselli kütüphane, platform ve ZIP çıkarma ayarları
- Oyun/mod kataloğunda arama, sayfalı sonuçlar ve modlara abone olma
- Oyun klasörlerine mod indirme, ZIP'leri güvenli çıkarma veya arşivi olduğu gibi kaydetme
- Eşitleme ve hesap durumu için işlem günlüğü
- Koyu, özel Electron masaüstü arayüzü

Oyun/mod katalog sonuçları her sayfada 40 öğe gösterir. Modlara abone olmak ve kütüphaneyi eşitlemek için mod.io hesabında oturum açın.

## Yerel ayarlar ve eski sürüm

Güncel ayarlar `%LOCALAPPDATA%\ModioManager\modio_config.electron.json` dosyasında tutulur. API anahtarı ve oturum belirteci Electron `safeStorage` ile Windows kullanıcı hesabına bağlı olarak şifrelenir. Oyun klasörleri ve indirme tercihleri aynı dosyada saklanır.

Önceki WPF sürümünün kaynak kodu `ModioManager` klasöründe bırakılmıştır; değiştirmeden önce alınan kaynak yedeği `backups\pre-electron-20261102-185852` klasöründedir. İlk çalıştırmada eski `%LOCALAPPDATA%\ModioManager\modio_config.json` dosyasındaki oyun klasörleri ve User ID içe alınır. Electron güvenli depolaması önceki DPAPI biçiminden farklı olduğundan API anahtarını bir kez yeniden girip giriş yapmanız gerekir. Eski ayar dosyası değiştirilmez.

## Proje yapısı

- `electron`: Güvenli ana süreç, API, yerel ayarlar, IPC ve eşitleme
- `renderer`: React + TypeScript kullanıcı arayüzü
- `ModioManager`: Önceki WPF/C# uygulama kaynakları
