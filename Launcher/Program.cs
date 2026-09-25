using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
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

    // ---- Janela principal --------------------------------------------------
    public class LauncherForm : Form
    {
        private const int WindowWidth = 820;
        private const int WindowHeight = 520;
        private const string DefaultGameName = "BLOODLUST";

        private readonly string _baseDir;
        private Image _background;
        private Image _logo;

        private string _status = "Iniciando...";
        private string _version = "";
        private int _progressValue;
        private GradientButton _playButton;

        public LauncherForm()
        {
            _baseDir = AppDomain.CurrentDomain.BaseDirectory;
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

            SetStatus("Verificando atualizações...");
            var result = await Updater.RunAsync(_baseDir, SetStatus, SetProgress);

            if (result.Success)
            {
                SetVersion("versão do servidor: " + (result.Version ?? "?"));
                EnablePlay();
                return;
            }

            var hasGame = File.Exists(Path.Combine(_baseDir, "main.exe"));
            SetStatus(hasGame ? "Não foi possível atualizar — você ainda pode jogar offline." : "Falha ao baixar o jogo.");

            MessageBox.Show(
                this,
                "Não foi possível verificar/baixar as atualizações:\n\n" + result.Error +
                (hasGame ? "\n\nVocê ainda pode iniciar o jogo com os arquivos atuais." : ""),
                "Bloodlust Launcher",
                MessageBoxButtons.OK,
                hasGame ? MessageBoxIcon.Warning : MessageBoxIcon.Error);

            if (hasGame) EnablePlay();
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
            var exe = Path.Combine(_baseDir, "main.exe");
            if (!File.Exists(exe))
            {
                MessageBox.Show(this, "main.exe não encontrado na pasta do jogo.", "Bloodlust Launcher",
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
                MessageBox.Show(this, "Falha ao iniciar o jogo:\n\n" + ex.Message, "Bloodlust Launcher",
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
