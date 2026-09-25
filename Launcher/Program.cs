using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
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
        public List<ManifestFile> files { get; set; }
    }

    public class UpdateResult
    {
        public bool Success;
        public string Version;
        public int Downloaded;
        public long Bytes;
        public string Error;
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

        public static async Task<UpdateResult> RunAsync(
            string baseDir,
            Action<string> onStatus,
            Action<int> onProgress)
        {
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

                long total = pending.Sum(f => f.size);
                long done = 0;

                for (int i = 0; i < pending.Count; i++)
                {
                    var file = pending[i];
                    onStatus(string.Format("Baixando {0}/{1}: {2}", i + 1, pending.Count, file.path));

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
                                done += read;
                                onProgress(total > 0 ? (int)(done * 100 / total) : 0);
                            }
                        }
                    }

                    if (File.Exists(localPath)) File.Delete(localPath);
                    File.Move(tempPath, localPath);
                    result.Downloaded++;
                    result.Bytes += file.size;
                }

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

        private static async Task<Manifest> FetchManifestAsync(string updatesUrl)
        {
            var url = updatesUrl + "/update-manifest.json?t=" + DateTime.UtcNow.Ticks;
            var json = await Http.GetStringAsync(url);
            var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            return serializer.Deserialize<Manifest>(json);
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

    // ---- Interface --------------------------------------------------------
    public class LauncherForm : Form
    {
        private readonly string _baseDir;
        private Label _statusLabel;
        private Label _versionLabel;
        private ProgressBar _progress;
        private Button _playButton;

        public LauncherForm()
        {
            _baseDir = AppDomain.CurrentDomain.BaseDirectory;
            BuildUi();
        }

        private void BuildUi()
        {
            Text = "MU Online 0.97k - Launcher";
            ClientSize = new Size(520, 270);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(16, 14, 12);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 9F);

            Controls.Add(new Label
            {
                Text = "MU ONLINE 0.97k",
                Font = new Font("Segoe UI", 20F, FontStyle.Bold),
                ForeColor = Color.FromArgb(235, 195, 95),
                TextAlign = ContentAlignment.MiddleCenter,
                Bounds = new Rectangle(0, 22, ClientSize.Width, 44)
            });

            _statusLabel = new Label
            {
                Text = "Iniciando...",
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = Color.Gainsboro,
                Bounds = new Rectangle(20, 92, ClientSize.Width - 40, 22)
            };
            Controls.Add(_statusLabel);

            _progress = new ProgressBar
            {
                Bounds = new Rectangle(20, 120, ClientSize.Width - 40, 22),
                Style = ProgressBarStyle.Continuous
            };
            Controls.Add(_progress);

            _playButton = new Button
            {
                Text = "JOGAR",
                Enabled = false,
                Font = new Font("Segoe UI", 12F, FontStyle.Bold),
                BackColor = Color.FromArgb(120, 40, 40),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Bounds = new Rectangle((ClientSize.Width - 170) / 2, 162, 170, 46)
            };
            _playButton.FlatAppearance.BorderColor = Color.FromArgb(200, 160, 70);
            _playButton.Click += (s, e) => LaunchGame();
            Controls.Add(_playButton);

            _versionLabel = new Label
            {
                Text = "verificando versão...",
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = Color.FromArgb(120, 120, 120),
                Bounds = new Rectangle(20, 220, ClientSize.Width - 40, 20)
            };
            Controls.Add(_versionLabel);
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);

            var result = await Updater.RunAsync(_baseDir, SetStatus, SetProgress);

            if (result.Success)
            {
                _versionLabel.Text = "versão do servidor: " + (result.Version ?? "?");
                EnablePlay();
                return;
            }

            var hasGame = File.Exists(Path.Combine(_baseDir, "main.exe"));
            SetStatus(hasGame ? "Não foi possível atualizar (jogando offline)." : "Falha ao baixar o jogo.");

            MessageBox.Show(
                this,
                "Não foi possível verificar/baixar as atualizações:\n\n" + result.Error +
                (hasGame ? "\n\nVocê ainda pode iniciar o jogo com os arquivos atuais." : ""),
                "MU Launcher",
                MessageBoxButtons.OK,
                hasGame ? MessageBoxIcon.Warning : MessageBoxIcon.Error);

            if (hasGame) EnablePlay();
        }

        private void SetStatus(string text)
        {
            if (InvokeRequired) { BeginInvoke(new Action(() => _statusLabel.Text = text)); return; }
            _statusLabel.Text = text;
        }

        private void SetProgress(int value)
        {
            var clamped = Math.Min(100, Math.Max(0, value));
            if (InvokeRequired) { BeginInvoke(new Action(() => _progress.Value = clamped)); return; }
            _progress.Value = clamped;
        }

        private void EnablePlay()
        {
            if (InvokeRequired) { BeginInvoke(new Action(EnablePlay)); return; }
            _playButton.Enabled = true;
            _playButton.BackColor = Color.FromArgb(60, 130, 60);
            _playButton.Focus();
        }

        private void LaunchGame()
        {
            var exe = Path.Combine(_baseDir, "main.exe");
            if (!File.Exists(exe))
            {
                MessageBox.Show(this, "main.exe não encontrado na pasta do jogo.", "MU Launcher",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = exe,
                    WorkingDirectory = _baseDir,
                    UseShellExecute = true
                });
                Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Falha ao iniciar o jogo:\n\n" + ex.Message, "MU Launcher",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            // Modo sem interface (util para testar/automatizar):
            //   Launcher.exe --update-only   -> baixa as atualizacoes e sai
            if (args != null && args.Any(a => string.Equals(a, "--update-only", StringComparison.OrdinalIgnoreCase)))
            {
                var baseDir = AppDomain.CurrentDomain.BaseDirectory;
                var log = new StringBuilder();
                var result = Updater.RunAsync(
                    baseDir,
                    s => log.AppendLine(s),
                    p => { }).GetAwaiter().GetResult();

                try
                {
                    File.WriteAllText(Path.Combine(baseDir, "launcher-update.log"),
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
