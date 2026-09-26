using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace MuLauncher
{
    // ---- Manifesto (mesmos nomes das chaves JSON) -------------------------
    public class ManifestFile
    {
        public string path { get; set; }
        public long size { get; set; }
        public string sha256 { get; set; }
    }

    public class Manifest
    {
        public string version { get; set; }
        public string generatedAt { get; set; }
        public string full { get; set; }
        public List<ManifestFile> files { get; set; }
    }

    public class UpdateResult
    {
        public bool Success;
        public string Version;
        public int Downloaded;
        public long Bytes;
        public string Error;
        public bool UsedFullPackage;
    }

    // ---- Logica de atualizacao -------------------------------------------
    public static class Updater
    {
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };

        /// <summary>URL base das atualizacoes. Pode ser sobreposta por MU_LAUNCHER_URL ou por launcher-url.txt.</summary>
        public static string ResolveUpdatesUrl(string baseDir)
        {
            var env = Environment.GetEnvironmentVariable("MU_LAUNCHER_URL");
            if (!string.IsNullOrWhiteSpace(env)) return env.Trim().TrimEnd('/');

            try
            {
                var cfg = Path.Combine(baseDir, "launcher-url.txt");
                if (File.Exists(cfg))
                {
                    var text = File.ReadAllText(cfg).Trim();
                    if (!string.IsNullOrWhiteSpace(text)) return text.TrimEnd('/');
                }
            }
            catch { /* ignora */ }

            return "http://147.15.49.32:8085/updates";
        }

        // downloads simultaneos (o padrao do .NET e 2 conexoes por host!)
        private const int ParallelDownloads = 8;
        // acima disso, baixa o pacote completo (1 zip) em vez de milhares de requisicoes
        private const int BulkThresholdFiles = 150;
        private const long BulkThresholdBytes = 40L * 1024 * 1024;

        /// <summary>Converte um caminho relativo ("/downloads/x.zip") em URL completa.</summary>
        public static string ResolveUrl(string updatesUrl, string caminho)
        {
            if (string.IsNullOrEmpty(caminho)) return null;
            if (caminho.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                caminho.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                return caminho;
            }
            var uri = new Uri(updatesUrl.EndsWith("/") ? updatesUrl : updatesUrl + "/");
            return new Uri(uri, caminho).ToString();
        }

        public static async Task<UpdateResult> RunAsync(
            string baseDir,
            Action<string> onStatus,
            Action<int> onProgress)
        {
            // o padrao do .NET Framework e 2 conexoes por host -> limita muito o paralelismo
            ServicePointManager.DefaultConnectionLimit = 32;
            ServicePointManager.Expect100Continue = false;

            var result = new UpdateResult { Success = false };
            var updatesUrl = ResolveUpdatesUrl(baseDir);
            var selfName = Path.GetFileName(Application.ExecutablePath);

            try
            {
                onStatus("Verificando atualizações...");
                var manifest = await FetchManifestAsync(updatesUrl);
                if (manifest == null || manifest.files == null || manifest.files.Count == 0)
                {
                    throw new Exception("Manifesto de atualização vazio ou inválido.");
                }

                result.Version = manifest.version;

                var pending = new List<ManifestFile>();
                foreach (var file in manifest.files)
                {
                    if (file == null || string.IsNullOrEmpty(file.path)) continue;
                    if (string.Equals(file.path, selfName, StringComparison.OrdinalIgnoreCase)) continue;

                    var localPath = LocalPath(baseDir, file.path);
                    if (!File.Exists(localPath)) { pending.Add(file); continue; }

                    if (new FileInfo(localPath).Length != file.size) { pending.Add(file); continue; }

                    if (!string.IsNullOrEmpty(file.sha256) &&
                        !string.Equals(ComputeSha256(localPath), file.sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        pending.Add(file);
                    }
                }

                if (pending.Count == 0)
                {
                    onProgress(100);
                    onStatus("O jogo já está atualizado!");
                    result.Success = true;
                    return result;
                }

                long pendingBytes = pending.Sum(f => f.size);

                // --- pacote completo quando quase tudo mudou (muito mais rapido) ---
                var zipUrl = ResolveUrl(updatesUrl, manifest.full);
                var bulk = !string.IsNullOrEmpty(zipUrl) &&
                           (pending.Count >= BulkThresholdFiles || pendingBytes >= BulkThresholdBytes);

                if (bulk)
                {
                    try
                    {
                        await DownloadFullPackageAsync(zipUrl, baseDir, manifest, onStatus, onProgress);
                        result.UsedFullPackage = true;
                        result.Downloaded = pending.Count;
                        onProgress(100);
                        onStatus("Atualização concluída! O jogo está pronto.");
                        result.Success = true;
                        return result;
                    }
                    catch
                    {
                        onStatus("Pacote completo falhou, baixando arquivos...");
                    }
                }

                // --- arquivos em paralelo ---
                await DownloadFilesParallelAsync(updatesUrl, baseDir, pending, onStatus, onProgress, result);

                onProgress(100);
                onStatus("Atualização concluída! O jogo está pronto.");
                result.Success = true;
                return result;
            }
            catch (Exception ex)
            {
                result.Error = ex.Message;
                return result;
            }
        }

        /// <summary>Baixa varios arquivos ao mesmo tempo (muito mais rapido que um a um).</summary>
        private static async Task DownloadFilesParallelAsync(
            string updatesUrl,
            string baseDir,
            List<ManifestFile> pending,
            Action<string> onStatus,
            Action<int> onProgress,
            UpdateResult result)
        {
            long total = pending.Sum(f => f.size);
            long done = 0;
            int baixados = 0;
            int ultimoPct = -1;
            var semaforo = new SemaphoreSlim(ParallelDownloads);

            var tarefas = new List<Task>();
            foreach (var item in pending)
            {
                await semaforo.WaitAsync();
                var file = item;

                tarefas.Add(Task.Run(async () =>
                {
                    try
                    {
                        var localPath = LocalPath(baseDir, file.path);
                        var dir = Path.GetDirectoryName(localPath);
                        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

                        var tempPath = localPath + ".download";
                        using (var resp = await Http.GetAsync(FileUrl(updatesUrl, file.path), HttpCompletionOption.ResponseHeadersRead))
                        {
                            resp.EnsureSuccessStatusCode();
                            using (var src = await resp.Content.ReadAsStreamAsync())
                            using (var dst = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true))
                            {
                                var buffer = new byte[81920];
                                int read;
                                while ((read = await src.ReadAsync(buffer, 0, buffer.Length)) > 0)
                                {
                                    await dst.WriteAsync(buffer, 0, read);
                                    var atual = Interlocked.Add(ref done, read);
                                    var pct = total > 0 ? (int)(atual * 100 / total) : 0;
                                    if (pct != ultimoPct)
                                    {
                                        ultimoPct = pct;
                                        onProgress(pct);
                                    }
                                }
                            }
                        }

                        if (File.Exists(localPath)) File.Delete(localPath);
                        File.Move(tempPath, localPath);

                        var feitos = Interlocked.Increment(ref baixados);
                        Interlocked.Add(ref result.Bytes, file.size);
                        onStatus(string.Format("Baixando arquivos... {0}/{1}", feitos, pending.Count));
                    }
                    finally
                    {
                        semaforo.Release();
                    }
                }));
            }

            await Task.WhenAll(tarefas);
            result.Downloaded = baixados;
        }

        /// <summary>Baixa o zip completo do jogo e aplica os arquivos (bem mais rapido numa instalacao nova).</summary>
        private static async Task DownloadFullPackageAsync(
            string zipUrl,
            string baseDir,
            Manifest manifest,
            Action<string> onStatus,
            Action<int> onProgress)
        {
            var tempZip = Path.Combine(Path.GetTempPath(), "bl-mu-client.zip");
            var tempDir = Path.Combine(Path.GetTempPath(), "bl-mu-client-" + Guid.NewGuid().ToString("N"));

            try
            {
                onStatus("Baixando pacote completo do jogo...");
                using (var resp = await Http.GetAsync(zipUrl, HttpCompletionOption.ResponseHeadersRead))
                {
                    resp.EnsureSuccessStatusCode();
                    var tamanhoTotal = resp.Content.Headers.ContentLength ?? -1;
                    long lidos = 0;
                    int ultimoPct = -1;

                    using (var src = await resp.Content.ReadAsStreamAsync())
                    using (var dst = new FileStream(tempZip, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true))
                    {
                        var buffer = new byte[81920];
                        int read;
                        while ((read = await src.ReadAsync(buffer, 0, buffer.Length)) > 0)
                        {
                            await dst.WriteAsync(buffer, 0, read);
                            lidos += read;
                            if (tamanhoTotal > 0)
                            {
                                // 85% da barra = download do pacote
                                var pct = (int)(lidos * 85 / tamanhoTotal);
                                if (pct != ultimoPct) { ultimoPct = pct; onProgress(pct); }
                            }
                        }
                    }
                }

                onStatus("Aplicando arquivos...");
                Directory.CreateDirectory(tempDir);
                ZipFile.ExtractToDirectory(tempZip, tempDir);

                var arquivos = manifest.files ?? new List<ManifestFile>();
                int copiados = 0;
                int pctAtual = -1;
                foreach (var file in arquivos)
                {
                    if (file == null || string.IsNullOrEmpty(file.path)) continue;
                    var origem = Path.Combine(tempDir, file.path.Replace('/', Path.DirectorySeparatorChar));
                    if (!File.Exists(origem)) continue;

                    var destino = LocalPath(baseDir, file.path);
                    var dir = Path.GetDirectoryName(destino);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    File.Copy(origem, destino, true);

                    copiados++;
                    var pct = 85 + (int)(copiados * 15L / Math.Max(1, arquivos.Count));
                    if (pct != pctAtual) { pctAtual = pct; onProgress(pct); }
                }

                onStatus(string.Format("Pacote aplicado ({0} arquivos).", copiados));
            }
            finally
            {
                try { if (File.Exists(tempZip)) File.Delete(tempZip); } catch { }
                try { if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true); } catch { }
            }
        }

        private static async Task<Manifest> FetchManifestAsync(string updatesUrl)
        {
            var url = updatesUrl + "/update-manifest.json?t=" + DateTime.UtcNow.Ticks;
            var json = await Http.GetStringAsync(url);
            var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            return serializer.Deserialize<Manifest>(json);
        }

        /// <summary>
        /// Lista (caminhos relativos) dos arquivos que pertencem ao JOGO, segundo o
        /// manifesto do servidor. Usada para nunca mexer em arquivos que nao sao do jogo
        /// (ex.: quando o jogador aponta a pasta para Downloads).
        /// Devolve null quando nao foi possivel obter o manifesto (nesse caso nada e movido).
        /// </summary>
        public static async Task<HashSet<string>> FetchGameFileSetAsync(string baseDir)
        {
            try
            {
                var manifest = await FetchManifestAsync(ResolveUpdatesUrl(baseDir));
                if (manifest == null || manifest.files == null) return null;

                var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var file in manifest.files)
                {
                    if (file == null || string.IsNullOrEmpty(file.path)) continue;
                    set.Add(file.path.Replace('\\', '/').TrimStart('/'));
                }
                return set.Count > 0 ? set : null;
            }
            catch
            {
                return null;
            }
        }

        private static string LocalPath(string baseDir, string relative)
        {
            var clean = relative.Replace('\\', '/').TrimStart('/');
            return Path.Combine(baseDir, clean.Replace('/', Path.DirectorySeparatorChar));
        }

        private static string FileUrl(string updatesUrl, string relative)
        {
            var parts = relative.Replace('\\', '/').TrimStart('/').Split('/');
            for (int i = 0; i < parts.Length; i++)
            {
                parts[i] = Uri.EscapeDataString(parts[i]);
            }
            return updatesUrl + "/" + string.Join("/", parts);
        }

        private static string ComputeSha256(string path)
        {
            using (var sha = SHA256.Create())
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 81920))
            {
                var hash = sha.ComputeHash(stream);
                var sb = new StringBuilder(hash.Length * 2);
                foreach (var b in hash) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }
    }

    // ---- Pasta do jogo / configuracoes ------------------------------------
    /// <summary>Configuracoes do launcher (launcher-config.json ao lado do executavel).</summary>
    public class LauncherConfig
    {
        public string installDir { get; set; }

        private const string FileName = "launcher-config.json";

        private static string PrimaryPath(string exeDir)
        {
            return Path.Combine(exeDir, FileName);
        }

        private static string FallbackPath()
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, "Bloodlust", FileName);
        }

        public static LauncherConfig Load(string exeDir)
        {
            foreach (var caminho in new[] { PrimaryPath(exeDir), FallbackPath() })
            {
                try
                {
                    if (!File.Exists(caminho)) continue;
                    var json = File.ReadAllText(caminho);
                    if (string.IsNullOrWhiteSpace(json)) continue;
                    var cfg = new JavaScriptSerializer().Deserialize<LauncherConfig>(json);
                    if (cfg != null) return cfg;
                }
                catch { /* config corrompida: ignora e usa o padrao */ }
            }
            return new LauncherConfig();
        }

        public void Save(string exeDir)
        {
            var json = new JavaScriptSerializer().Serialize(this);
            foreach (var caminho in new[] { PrimaryPath(exeDir), FallbackPath() })
            {
                try
                {
                    var dir = Path.GetDirectoryName(caminho);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    File.WriteAllText(caminho, json);
                    return;
                }
                catch { /* tenta o proximo local */ }
            }
        }
    }

    /// <summary>Descobre/gerencia a pasta onde o jogo e baixado.</summary>
    public static class GameFolder
    {
        public const string DefaultFolderName = "Bloodlust";

        /// <summary>Pasta Documentos do usuario (nunca vazia).</summary>
        public static string Documents()
        {
            var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            if (string.IsNullOrWhiteSpace(docs)) docs = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (string.IsNullOrWhiteSpace(docs)) docs = AppDomain.CurrentDomain.BaseDirectory;
            return docs;
        }

        /// <summary>Pasta padrao sugerida: Documentos\Bloodlust.</summary>
        public static string DefaultDir()
        {
            return Path.Combine(Documents(), DefaultFolderName);
        }

        /// <summary>
        /// Onde o jogo fica, nesta ordem:
        ///   1. a pasta escolhida pelo jogador (launcher-config.json)
        ///   2. uma instalacao ja existente ao lado do launcher (compatibilidade)
        ///   3. Documentos\Bloodlust (padrao para instalacoes novas)
        /// </summary>
        public static string Resolve(string exeDir, LauncherConfig cfg)
        {
            var salvo = cfg != null ? cfg.installDir : null;
            if (!string.IsNullOrWhiteSpace(salvo))
            {
                try { return Path.GetFullPath(salvo.Trim()); }
                catch { /* caminho invalido: cai no padrao */ }
            }

            if (File.Exists(Path.Combine(exeDir, "main.exe"))) return exeDir;

            return DefaultDir();
        }

        /// <summary>Arquivos do proprio launcher: nunca sao movidos junto com o jogo.</summary>
        private static readonly string[] LauncherOwnFiles =
        {
            "launcher.exe", "launcher.exe.config", "launcher-config.json",
            "launcher-url.txt", "launcher-update.log"
        };

        public static bool IsLauncherFile(string nome)
        {
            return LauncherOwnFiles.Any(f => string.Equals(f, nome, StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>
        /// Quantos arquivos do manifesto existem de fato nessa pasta. Serve para saber
        /// se a pasta realmente contem o jogo antes de mexer em qualquer coisa.
        /// </summary>
        public static int CountGameFiles(string pasta, HashSet<string> gameFiles)
        {
            if (string.IsNullOrWhiteSpace(pasta) || gameFiles == null || gameFiles.Count == 0) return 0;

            int total = 0;
            foreach (var relativo in gameFiles)
            {
                if (string.IsNullOrWhiteSpace(relativo)) continue;
                try
                {
                    if (File.Exists(Path.Combine(pasta, relativo))) total++;
                }
                catch { /* caminho invalido: ignora */ }
            }
            return total;
        }

        /// <summary>
        /// Move o conteudo do jogo de uma pasta para outra (evita rebaixar tudo ao trocar
        /// a pasta). SOMENTE arquivos que constam no manifesto do servidor sao movidos:
        /// assim nada que nao seja do jogo e arrastado junto (Downloads, Documentos, etc.).
        /// Arquivos em uso sao ignorados e serao baixados de novo.
        /// </summary>
        public static int MoveContents(string origem, string destino, HashSet<string> gameFiles)
        {
            if (string.IsNullOrWhiteSpace(origem) || string.IsNullOrWhiteSpace(destino)) return 0;
            if (gameFiles == null || gameFiles.Count == 0) return 0;

            var de = Path.GetFullPath(origem).TrimEnd(Path.DirectorySeparatorChar);
            var para = Path.GetFullPath(destino).TrimEnd(Path.DirectorySeparatorChar);
            if (string.Equals(de, para, StringComparison.OrdinalIgnoreCase)) return 0;

            var sep = Path.DirectorySeparatorChar;
            if ((para + sep).StartsWith(de + sep, StringComparison.OrdinalIgnoreCase)) return 0;
            if ((de + sep).StartsWith(para + sep, StringComparison.OrdinalIgnoreCase)) return 0;

            Directory.CreateDirectory(destino);
            int movidos = 0;

            foreach (var relativo in gameFiles)
            {
                if (string.IsNullOrWhiteSpace(relativo)) continue;
                if (IsLauncherFile(Path.GetFileName(relativo))) continue;

                string arquivo;
                string alvo;
                try
                {
                    arquivo = Path.GetFullPath(Path.Combine(origem, relativo));
                    alvo = Path.GetFullPath(Path.Combine(destino, relativo));
                }
                catch { continue; }

                // Sanidade: o caminho tem de ficar mesmo dentro da pasta de origem.
                if (!arquivo.StartsWith(de + sep, StringComparison.OrdinalIgnoreCase)) continue;
                if (!File.Exists(arquivo)) continue;

                try
                {
                    var pastaAlvo = Path.GetDirectoryName(alvo);
                    if (!string.IsNullOrEmpty(pastaAlvo)) Directory.CreateDirectory(pastaAlvo);
                    if (File.Exists(alvo)) File.Delete(alvo);
                    try { File.Move(arquivo, alvo); }
                    catch (IOException) { File.Copy(arquivo, alvo, true); File.Delete(arquivo); }
                    movidos++;
                }
                catch { /* arquivo em uso: sera baixado de novo */ }
            }

            return movidos;
        }

        private static void CopyDirectory(string origem, string destino)
        {
            Directory.CreateDirectory(destino);
            foreach (var arquivo in Directory.GetFiles(origem))
            {
                File.Copy(arquivo, Path.Combine(destino, Path.GetFileName(arquivo)), true);
            }
            foreach (var pasta in Directory.GetDirectories(origem))
            {
                CopyDirectory(pasta, Path.Combine(destino, Path.GetFileName(pasta)));
            }
        }
    }

    // ---- Controles com estilo de jogo -------------------------------------
    internal static class Ui
    {
        public static GraphicsPath RoundedRect(Rectangle r, int radius)
        {
            int d = Math.Max(2, radius * 2);
            var path = new GraphicsPath();
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    internal sealed class GradientButton : Button
    {
        public Color ColorTop = Color.FromArgb(250, 228, 170);
        public Color ColorBottom = Color.FromArgb(214, 160, 74);
        public Color ColorTopHover = Color.FromArgb(255, 244, 210);
        public Color ColorBottomHover = Color.FromArgb(236, 186, 104);
        public Color BorderColor = Color.FromArgb(255, 240, 200);
        public Color DisabledTop = Color.FromArgb(78, 74, 68);
        public Color DisabledBottom = Color.FromArgb(52, 49, 45);

        private bool _hover;

        public GradientButton()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            Cursor = Cursors.Hand;
            Font = new Font("Segoe UI", 14F, FontStyle.Bold);
            TabStop = false;
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using (var path = Ui.RoundedRect(rect, 12))
            {
                Color top = Enabled ? (_hover ? ColorTopHover : ColorTop) : DisabledTop;
                Color bottom = Enabled ? (_hover ? ColorBottomHover : ColorBottom) : DisabledBottom;

                using (var brush = new LinearGradientBrush(rect, top, bottom, 90f))
                    g.FillPath(brush, path);

                if (Enabled)
                {
                    using (var pen = new Pen(BorderColor, 1.6f))
                        g.DrawPath(pen, path);
                }
            }

            TextRenderer.DrawText(
                g, Text, Font, rect,
                Enabled ? Color.FromArgb(28, 20, 8) : Color.FromArgb(175, 172, 165),
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
    }

    /// <summary>Botao de engrenagem (configuracoes), desenhado a mao para nao depender de fonte.</summary>
    internal sealed class GearButton : Control
    {
        private bool _hover;

        public GearButton()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                     ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
            TabStop = false;
            Size = new Size(42, 42);
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using (var path = Ui.RoundedRect(rect, 10))
            {
                using (var fundo = new SolidBrush(Color.FromArgb(_hover ? 165 : 105, 0, 0, 0)))
                    g.FillPath(fundo, path);

                using (var borda = new Pen(Color.FromArgb(_hover ? 230 : 150, 214, 160, 74), 1.2f))
                    g.DrawPath(borda, path);
            }

            var cor = Enabled
                ? (_hover ? Color.FromArgb(255, 246, 214) : Color.FromArgb(224, 176, 97))
                : Color.FromArgb(120, 116, 110);

            float cx = Width / 2f;
            float cy = Height / 2f;
            float raio = Math.Min(Width, Height) * 0.255f;
            float dente = Math.Max(3f, Width * 0.105f);
            float furo = raio * 0.44f;

            using (var brush = new SolidBrush(cor))
            {
                // dentes
                var estado = g.Save();
                g.TranslateTransform(cx, cy);
                for (int i = 0; i < 8; i++)
                {
                    g.FillRectangle(brush, -dente / 2f, -raio - dente * 0.85f, dente, dente * 1.7f);
                    g.RotateTransform(45f);
                }
                g.Restore(estado);

                // corpo com furo central de verdade (FillMode.Alternate)
                using (var corpo = new GraphicsPath(FillMode.Alternate))
                {
                    corpo.AddEllipse(cx - raio, cy - raio, raio * 2f, raio * 2f);
                    corpo.AddEllipse(cx - furo, cy - furo, furo * 2f, furo * 2f);
                    g.FillPath(brush, corpo);
                }
            }
        }
    }

    // ---- Janela principal --------------------------------------------------
    public class LauncherForm : Form
    {
        private const int WindowWidth = 820;
        private const int WindowHeight = 520;
        private const string DefaultGameName = "BLOODLUST";

        private readonly string _exeDir;
        private string _gameDir;
        private LauncherConfig _config;
        private Image _background;
        private Image _logo;

        private string _status = "Iniciando...";
        private string _version = "";
        private int _progressValue;
        private GradientButton _playButton;
        private GearButton _gearButton;

        public LauncherForm()
        {
            _exeDir = AppDomain.CurrentDomain.BaseDirectory;
            _config = LauncherConfig.Load(_exeDir);
            _gameDir = GameFolder.Resolve(_exeDir, _config);
            LoadEmbeddedAssets();
            BuildUi();
        }

        private static Image LoadEmbeddedImage(string suffix)
        {
            try
            {
                var asm = Assembly.GetExecutingAssembly();
                var name = asm.GetManifestResourceNames()
                    .FirstOrDefault(n => n.EndsWith(suffix, StringComparison.OrdinalIgnoreCase));
                if (name == null) return null;

                using (var stream = asm.GetManifestResourceStream(name))
                {
                    if (stream == null) return null;
                    using (var ms = new MemoryStream())
                    {
                        stream.CopyTo(ms);
                        ms.Position = 0;
                        return Image.FromStream(ms);
                    }
                }
            }
            catch { return null; }
        }

        private void LoadEmbeddedAssets()
        {
            _background = LoadEmbeddedImage("launcher-bg.jpg");
            _logo = LoadEmbeddedImage("launcher-logo.png");
        }

        private void BuildUi()
        {
            Text = "Bloodlust MU Online - Launcher";
            ClientSize = new Size(WindowWidth, WindowHeight);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(10, 8, 7);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 9F);
            DoubleBuffered = true;

            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            _playButton = new GradientButton
            {
                Text = "JOGAR",
                Enabled = false,
                Bounds = new Rectangle((WindowWidth - 240) / 2, 348, 240, 62)
            };
            _playButton.Click += (s, e) => LaunchGame();
            Controls.Add(_playButton);

            _gearButton = new GearButton
            {
                Bounds = new Rectangle(WindowWidth - 64, 22, 42, 42),
                Enabled = false
            };
            _gearButton.Click += (s, e) => OpenSettings();
            Controls.Add(_gearButton);
            _gearButton.BringToFront();

            var dica = new ToolTip();
            dica.SetToolTip(_gearButton, "Configurações — escolher a pasta de download do jogo");
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            var g = e.Graphics;
            var rect = ClientRectangle;

            using (var bg = new SolidBrush(Color.FromArgb(10, 8, 7)))
                g.FillRectangle(bg, rect);

            if (_background != null)
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                float scale = Math.Max((float)rect.Width / _background.Width, (float)rect.Height / _background.Height);
                int w = (int)(_background.Width * scale);
                int h = (int)(_background.Height * scale);
                g.DrawImage(_background, new Rectangle((rect.Width - w) / 2, (rect.Height - h) / 2, w, h));
            }

            using (var overlay = new LinearGradientBrush(rect, Color.FromArgb(140, 0, 0, 0), Color.FromArgb(228, 0, 0, 0), 90f))
                g.FillRectangle(overlay, rect);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

            if (_logo != null)
            {
                int logoWidth = 380;
                int logoHeight = (int)(logoWidth * ((float)_logo.Height / _logo.Width));
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(_logo, new Rectangle((Width - logoWidth) / 2, 30, logoWidth, logoHeight));
            }
            else
            {
                using (var font = new Font("Segoe UI", 30F, FontStyle.Bold))
                using (var brush = new SolidBrush(Color.FromArgb(244, 208, 122)))
                {
                    var r = new Rectangle(0, 40, Width, 60);
                    var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                    g.DrawString(DefaultGameName, font, brush, r, sf);
                }
            }

            // status
            using (var font = new Font("Segoe UI", 10F))
            using (var brush = new SolidBrush(Color.FromArgb(236, 231, 221)))
            {
                var r = new Rectangle(30, 268, Width - 60, 22);
                var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                g.DrawString(_status ?? string.Empty, font, brush, r, sf);
            }

            // barra de progresso
            var track = new Rectangle(150, 300, Width - 300, 16);
            using (var path = Ui.RoundedRect(track, 8))
            {
                using (var trackBrush = new SolidBrush(Color.FromArgb(190, 0, 0, 0)))
                    g.FillPath(trackBrush, path);

                int fillWidth = (int)((track.Width - 4) * (_progressValue / 100.0));
                if (fillWidth > 3)
                {
                    var fillRect = new Rectangle(track.X + 2, track.Y + 2, fillWidth, track.Height - 4);
                    using (var fillPath = Ui.RoundedRect(fillRect, 6))
                    using (var brush = new LinearGradientBrush(fillRect, Color.FromArgb(250, 228, 170), Color.FromArgb(214, 160, 74), 90f))
                        g.FillPath(brush, fillPath);
                }

                using (var pen = new Pen(Color.FromArgb(130, 214, 160, 74), 1f))
                    g.DrawPath(pen, path);
            }

            // pasta onde o jogo esta sendo baixado
            using (var font = new Font("Segoe UI", 8F))
            using (var brush = new SolidBrush(Color.FromArgb(150, 144, 133)))
            {
                var r = new Rectangle(30, Height - 66, Width - 60, 18);
                var sf = new StringFormat
                {
                    Alignment = StringAlignment.Center,
                    LineAlignment = StringAlignment.Center,
                    Trimming = StringTrimming.EllipsisPath
                };
                g.DrawString("Pasta: " + (_gameDir ?? string.Empty), font, brush, r, sf);
            }

            // rodape
            using (var font = new Font("Segoe UI", 8.5F))
            using (var brush = new SolidBrush(Color.FromArgb(170, 163, 152)))
            {
                var r = new Rectangle(30, Height - 44, Width - 60, 20);
                var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                g.DrawString(_version ?? string.Empty, font, brush, r, sf);
            }
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            await RunUpdateAsync();
        }

        /// <summary>Baixa/atualiza o jogo na pasta configurada.</summary>
        private async Task RunUpdateAsync()
        {
            _gearButton.Enabled = false;
            _playButton.Enabled = false;
            _progressValue = 0;
            Invalidate();

            try
            {
                Directory.CreateDirectory(_gameDir);
            }
            catch (Exception ex)
            {
                SetStatus("Não foi possível usar a pasta configurada.");
                MessageBox.Show(
                    this,
                    "Não foi possível criar/usar a pasta do jogo:\n\n" + _gameDir + "\n\n" + ex.Message +
                    "\n\nClique na engrenagem (canto superior direito) para escolher outra pasta.",
                    "Bloodlust Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
                _gearButton.Enabled = true;
                return;
            }

            SetStatus("Verificando atualizações...");
            var instalacaoNova = !File.Exists(Path.Combine(_gameDir, "main.exe"));
            var result = await Updater.RunAsync(_gameDir, SetStatus, SetProgress);

            if (result.Success)
            {
                SetVersion("versão do servidor: " + (result.Version ?? "?") +
                           (result.Downloaded > 0
                               ? string.Format("  •  {0} arquivo(s), {1:N1} MB", result.Downloaded, result.Bytes / 1048576.0)
                               : ""));
                EnablePlay();
                _gearButton.Enabled = true;

                // Deixa o launcher junto do jogo (e na Area de Trabalho na primeira
                // instalacao), para o jogador nao precisar procurar o atalho.
                EnsureLauncherCopies(instalacaoNova);
                return;
            }

            var hasGame = File.Exists(Path.Combine(_gameDir, "main.exe"));
            SetStatus(hasGame ? "Não foi possível atualizar — você ainda pode jogar offline." : "Falha ao baixar o jogo.");

            MessageBox.Show(
                this,
                "Não foi possível verificar/baixar as atualizações:\n\n" + result.Error +
                "\n\nPasta: " + _gameDir +
                (hasGame ? "\n\nVocê ainda pode iniciar o jogo com os arquivos atuais." : "") +
                "\n\nClique na engrenagem (canto superior direito) para escolher outra pasta.",
                "Bloodlust Launcher",
                MessageBoxButtons.OK,
                hasGame ? MessageBoxIcon.Warning : MessageBoxIcon.Error);

            if (hasGame) EnablePlay();
            _gearButton.Enabled = true;
        }

        /// <summary>
        /// Deixa uma copia do launcher dentro da pasta do jogo (o jogo fica completo,
        /// sem depender de onde o launcher foi baixado) e, na primeira instalacao,
        /// tambem na Area de Trabalho para abrir com dois cliques.
        /// </summary>
        private void EnsureLauncherCopies(bool instalacaoNova)
        {
            string self;
            try { self = Application.ExecutablePath; }
            catch { return; }
            if (string.IsNullOrWhiteSpace(self) || !File.Exists(self)) return;

            var nome = Path.GetFileName(self);
            var destinos = new List<string>();

            try { destinos.Add(Path.Combine(_gameDir, nome)); } catch { }

            if (instalacaoNova)
            {
                try
                {
                    var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    if (!string.IsNullOrWhiteSpace(desktop)) destinos.Add(Path.Combine(desktop, nome));
                }
                catch { /* sem Area de Trabalho: ignora */ }
            }

            foreach (var destino in destinos)
            {
                try
                {
                    var alvo = Path.GetFullPath(destino);
                    if (string.Equals(alvo, Path.GetFullPath(self), StringComparison.OrdinalIgnoreCase)) continue;
                    File.Copy(self, alvo, true);
                }
                catch { /* arquivo em uso ou sem permissao: ignora */ }
            }
        }

        /// <summary>Engrenagem: escolher a pasta onde o jogo e baixado.</summary>
        private async void OpenSettings()
        {
            var anterior = _gameDir;

            using (var dlg = new SettingsForm(_gameDir, _exeDir))
            {
                if (dlg.ShowDialog(this) != DialogResult.OK) return;

                var novo = dlg.SelectedPath;
                if (string.IsNullOrWhiteSpace(novo)) return;

                string anteriorFull;
                string novoFull;
                try
                {
                    anteriorFull = Path.GetFullPath(anterior);
                    novoFull = Path.GetFullPath(novo);
                }
                catch { return; }

                if (string.Equals(anteriorFull, novoFull, StringComparison.OrdinalIgnoreCase)) return;

                if (File.Exists(Path.Combine(anteriorFull, "main.exe")))
                {
                    SetStatus("Conferindo os arquivos do jogo...");

                    // Lista oficial do que e do jogo: nada fora dela e movido.
                    var gameFiles = await Updater.FetchGameFileSetAsync(_exeDir);
                    var presentes = GameFolder.CountGameFiles(anteriorFull, gameFiles);

                    if (gameFiles == null)
                    {
                        SetStatus("Sem resposta do servidor para listar o jogo — nada será movido. Baixando na pasta nova...");
                    }
                    else if (presentes < 3)
                    {
                        SetStatus("A pasta antiga não tem os arquivos do jogo — baixando tudo na pasta nova...");
                    }
                    else
                    {
                        var resposta = MessageBox.Show(
                            this,
                            "Mover os arquivos do jogo que já estão em:\n\n" + anteriorFull +
                            "\n\npara:\n\n" + novoFull +
                            "\n\nSó os " + presentes + " arquivos do jogo são movidos — o resto da pasta não é tocado." +
                            "\n\nEscolha \"Não\" para baixar tudo de novo na pasta nova.",
                            "Bloodlust Launcher", MessageBoxButtons.YesNo, MessageBoxIcon.Question);

                        if (resposta == DialogResult.Yes)
                        {
                            SetStatus("Movendo arquivos do jogo...");
                            try
                            {
                                var movidos = GameFolder.MoveContents(anteriorFull, novoFull, gameFiles);
                                SetStatus(string.Format("{0} arquivo(s) do jogo movido(s). Conferindo atualizações...", movidos));
                            }
                            catch (Exception ex)
                            {
                                MessageBox.Show(
                                    this,
                                    "Não foi possível mover tudo:\n\n" + ex.Message +
                                    "\n\nO que faltar será baixado de novo.",
                                    "Bloodlust Launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                            }
                        }
                    }
                }

                _gameDir = novoFull;
                _config.installDir = novoFull;
                _config.Save(_exeDir);
                Invalidate();
            }

            await RunUpdateAsync();
        }

        private void SetStatus(string text)
        {
            if (InvokeRequired) { BeginInvoke(new Action<string>(SetStatus), text); return; }
            _status = text;
            Invalidate();
        }

        private void SetProgress(int value)
        {
            if (InvokeRequired) { BeginInvoke(new Action<int>(SetProgress), value); return; }
            _progressValue = Math.Min(100, Math.Max(0, value));
            Invalidate();
        }

        private void SetVersion(string text)
        {
            if (InvokeRequired) { BeginInvoke(new Action<string>(SetVersion), text); return; }
            _version = text;
            Invalidate();
        }

        private void EnablePlay()
        {
            if (InvokeRequired) { BeginInvoke(new Action(EnablePlay)); return; }
            _progressValue = 100;
            _playButton.Enabled = true;
            _playButton.Focus();
            Invalidate();
        }

        private void LaunchGame()
        {
            var exe = Path.Combine(_gameDir, "main.exe");
            if (!File.Exists(exe))
            {
                MessageBox.Show(this, "main.exe não encontrado na pasta do jogo:\n\n" + _gameDir, "Bloodlust Launcher",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = exe,
                    WorkingDirectory = _gameDir,
                    UseShellExecute = true
                });
                Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Falha ao iniciar o jogo:\n\n" + ex.Message, "Bloodlust Launcher",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    // ---- Janela de configuracoes (engrenagem) ------------------------------
    internal sealed class SettingsForm : Form
    {
        private string _pasta;
        private TextBox _caminho;
        private Label _espaco;
        private Label _aviso;

        public string SelectedPath
        {
            get { return _pasta; }
        }

        public SettingsForm(string pastaAtual, string exeDir)
        {
            _pasta = string.IsNullOrWhiteSpace(pastaAtual) ? GameFolder.DefaultDir() : pastaAtual;
            BuildUi();
            AtualizarTextos();
        }

        private void BuildUi()
        {
            Text = "Configurações — Bloodlust Launcher";
            ClientSize = new Size(640, 322);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            BackColor = Color.FromArgb(20, 17, 15);
            ForeColor = Color.FromArgb(236, 231, 221);
            Font = new Font("Segoe UI", 9F);

            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            Controls.Add(new Label
            {
                Text = "PASTA DE DOWNLOAD",
                Font = new Font("Segoe UI", 14F, FontStyle.Bold),
                ForeColor = Color.FromArgb(235, 195, 95),
                Bounds = new Rectangle(24, 18, ClientSize.Width - 48, 28)
            });

            Controls.Add(new Label
            {
                Text = "O launcher baixa o jogo (main.exe e a pasta Data) para o local abaixo.\n" +
                       "Use uma pasta sua — como Documentos — para não ter problema de permissão.",
                ForeColor = Color.FromArgb(180, 174, 164),
                Bounds = new Rectangle(24, 52, ClientSize.Width - 48, 36)
            });

            _caminho = new TextBox
            {
                ReadOnly = true,
                Bounds = new Rectangle(24, 98, ClientSize.Width - 48, 26),
                BackColor = Color.FromArgb(38, 33, 28),
                ForeColor = Color.FromArgb(240, 235, 226),
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Consolas", 9.5F)
            };
            Controls.Add(_caminho);

            var alterar = Botao("Alterar pasta...", 24, 136, 152);
            alterar.Click += (s, e) => EscolherPasta();
            Controls.Add(alterar);

            var padrao = Botao("Usar Documentos", 184, 136, 164);
            padrao.Click += (s, e) =>
            {
                _pasta = GameFolder.DefaultDir();
                AtualizarTextos();
            };
            Controls.Add(padrao);

            var abrir = Botao("Abrir pasta", 356, 136, 124);
            abrir.Click += (s, e) => AbrirPasta();
            Controls.Add(abrir);

            _espaco = new Label
            {
                Bounds = new Rectangle(24, 176, ClientSize.Width - 48, 20),
                ForeColor = Color.FromArgb(170, 163, 152)
            };
            Controls.Add(_espaco);

            _aviso = new Label
            {
                Bounds = new Rectangle(24, 198, ClientSize.Width - 48, 34),
                ForeColor = Color.FromArgb(205, 199, 189)
            };
            Controls.Add(_aviso);

            var salvar = new GradientButton
            {
                Text = "SALVAR",
                Font = new Font("Segoe UI", 11F, FontStyle.Bold),
                Bounds = new Rectangle(ClientSize.Width - 24 - 170, 252, 170, 46)
            };
            salvar.Click += (s, e) => Confirmar();
            Controls.Add(salvar);
            AcceptButton = salvar;

            var cancelar = Botao("Cancelar", ClientSize.Width - 24 - 170 - 132, 252, 122, 46);
            cancelar.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); };
            Controls.Add(cancelar);
            CancelButton = cancelar;
        }

        private static Button Botao(string texto, int x, int y, int largura, int altura = 32)
        {
            var b = new Button
            {
                Text = texto,
                Bounds = new Rectangle(x, y, largura, altura),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(46, 39, 32),
                ForeColor = Color.FromArgb(236, 231, 221),
                Font = new Font("Segoe UI", 9F)
            };
            b.FlatAppearance.BorderColor = Color.FromArgb(120, 214, 160, 74);
            return b;
        }

        private void AtualizarTextos()
        {
            _caminho.Text = _pasta;
            AtualizarEspaco();

            var ehPadrao = false;
            try
            {
                ehPadrao = string.Equals(
                    Path.GetFullPath(_pasta).TrimEnd(Path.DirectorySeparatorChar),
                    Path.GetFullPath(GameFolder.DefaultDir()).TrimEnd(Path.DirectorySeparatorChar),
                    StringComparison.OrdinalIgnoreCase);
            }
            catch { /* caminho invalido */ }

            _aviso.Text = ehPadrao
                ? "Pasta padrão: Documentos\\Bloodlust (recomendado)."
                : "Pasta personalizada — o jogo será baixado aqui.";
        }

        private void AtualizarEspaco()
        {
            try
            {
                var raiz = Path.GetPathRoot(Path.GetFullPath(_pasta));
                var drive = new DriveInfo(raiz);
                var livre = drive.AvailableFreeSpace / 1073741824.0;
                _espaco.Text = string.Format(
                    "Espaço livre em {0} {1:N1} GB   (o jogo ocupa cerca de 210 MB)",
                    drive.Name.TrimEnd(Path.DirectorySeparatorChar), livre);
                _espaco.ForeColor = livre < 1 ? Color.FromArgb(255, 140, 140) : Color.FromArgb(170, 163, 152);
            }
            catch
            {
                _espaco.Text = string.Empty;
            }
        }

        private void EscolherPasta()
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "Escolha a pasta onde o jogo será baixado";
                dlg.ShowNewFolderButton = true;

                // abre já na pasta configurada; se ela ainda não existe, começa em Documentos
                dlg.SelectedPath = Directory.Exists(_pasta) ? _pasta : GameFolder.Documents();

                if (dlg.ShowDialog(this) == DialogResult.OK && !string.IsNullOrWhiteSpace(dlg.SelectedPath))
                {
                    _pasta = dlg.SelectedPath;
                    AtualizarTextos();
                }
            }
        }

        private void AbrirPasta()
        {
            try
            {
                Directory.CreateDirectory(_pasta);
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = _pasta,
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Não foi possível abrir a pasta:\n\n" + ex.Message,
                    "Bloodlust Launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void Confirmar()
        {
            string completo;
            try
            {
                completo = Path.GetFullPath(_pasta);
            }
            catch
            {
                MessageBox.Show(this, "Caminho inválido.", "Bloodlust Launcher",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            try
            {
                // confirma de verdade que da para escrever ai
                Directory.CreateDirectory(completo);
                var teste = Path.Combine(completo, ".bloodlust-teste");
                File.WriteAllText(teste, "ok");
                File.Delete(teste);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    this,
                    "Não foi possível escrever nesta pasta:\n\n" + completo + "\n\n" + ex.Message +
                    "\n\nEscolha outra pasta (por exemplo, dentro de Documentos).",
                    "Bloodlust Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            _pasta = completo;
            DialogResult = DialogResult.OK;
            Close();
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            var exeDir = AppDomain.CurrentDomain.BaseDirectory;
            var config = LauncherConfig.Load(exeDir);
            var gameDir = GameFolder.Resolve(exeDir, config);

            // Diagnostico (sem interface): mostra em que pasta o jogo vai ficar e sai.
            //   Launcher.exe --show-config > config.txt
            if (args != null && args.Any(a => string.Equals(a, "--show-config", StringComparison.OrdinalIgnoreCase)))
            {
                Console.WriteLine("exeDir      = " + exeDir);
                Console.WriteLine("installDir  = " + (string.IsNullOrWhiteSpace(config.installDir) ? "(nao definido)" : config.installDir));
                Console.WriteLine("gameDir     = " + gameDir);
                Console.WriteLine("pastaExiste = " + Directory.Exists(gameDir));
                Console.WriteLine("mainExe     = " + File.Exists(Path.Combine(gameDir, "main.exe")));
                Environment.Exit(0);
                return;
            }

            // Abre direto a janela de configuracoes, sem baixar nada (util para suporte):
            //   Launcher.exe --settings
            if (args != null && args.Any(a => string.Equals(a, "--settings", StringComparison.OrdinalIgnoreCase)))
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var dlg = new SettingsForm(gameDir, exeDir))
                {
                    if (dlg.ShowDialog() == DialogResult.OK && !string.IsNullOrWhiteSpace(dlg.SelectedPath))
                    {
                        config.installDir = dlg.SelectedPath;
                        config.Save(exeDir);
                    }
                }
                Environment.Exit(0);
                return;
            }

            // Modo sem interface (util para testar/automatizar):
            //   Launcher.exe --update-only   -> baixa as atualizacoes e sai
            if (args != null && args.Any(a => string.Equals(a, "--update-only", StringComparison.OrdinalIgnoreCase)))
            {
                var log = new StringBuilder();
                log.AppendLine("pasta do jogo: " + gameDir);

                UpdateResult result;
                try
                {
                    Directory.CreateDirectory(gameDir);
                    result = Updater.RunAsync(
                        gameDir,
                        s => log.AppendLine(s),
                        p => { }).GetAwaiter().GetResult();
                }
                catch (Exception ex)
                {
                    result = new UpdateResult { Success = false, Error = ex.Message };
                }

                try
                {
                    File.WriteAllText(Path.Combine(exeDir, "launcher-update.log"),
                        log.ToString() + (result.Success ? "OK" : "ERRO: " + result.Error));
                }
                catch { /* ignora */ }

                Environment.Exit(result.Success ? 0 : 1);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm());
        }
    }
}
