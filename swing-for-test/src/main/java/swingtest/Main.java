package swingtest;

import java.awt.BorderLayout;
import java.awt.FlowLayout;
import java.awt.GridBagConstraints;
import java.awt.GridBagLayout;
import java.awt.Insets;
import javax.swing.BorderFactory;
import javax.swing.DefaultListModel;
import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JList;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JPasswordField;
import javax.swing.JScrollPane;
import javax.swing.JTabbedPane;
import javax.swing.JTextField;
import javax.swing.SwingUtilities;

/**
 * A small Swing app to exercise a future e2e engine: a sign-in form and a
 * todo list, covering text and password fields, a checkbox, a combo box,
 * buttons, a list, tabs, and a modal dialog. Every interactive component has
 * a stable {@code setName} for locators and an accessible name for the
 * accessibility tree.
 */
public final class Main {

    private Main() {
    }

    public static void main(String[] args) {
        SwingUtilities.invokeLater(Main::createAndShow);
    }

    private static void createAndShow() {
        JFrame frame = new JFrame("Swing for Test");
        frame.setName("main-window");
        frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);

        JTabbedPane tabs = new JTabbedPane();
        tabs.setName("tabs");
        tabs.addTab("Sign in", signInPanel(frame));
        tabs.addTab("Todos", todoPanel());

        frame.getContentPane().add(tabs, BorderLayout.CENTER);
        frame.setSize(480, 360);
        frame.setLocationRelativeTo(null);
        frame.setVisible(true);
    }

    /** The sign-in tab: accepts user "demo" with password "secret". */
    private static JPanel signInPanel(JFrame frame) {
        JTextField username = named(new JTextField(16), "username", "Username");
        JPasswordField password = named(new JPasswordField(16), "password", "Password");
        JComboBox<String> role = named(new JComboBox<>(new String[] {"Viewer", "Editor", "Admin"}), "role", "Role");
        JCheckBox remember = named(new JCheckBox("Remember me"), "remember", "Remember me");
        JButton signIn = named(new JButton("Sign in"), "sign-in", "Sign in");
        JLabel status = named(new JLabel(" "), "status", "Status");

        signIn.addActionListener(e -> {
            String user = username.getText().trim();
            String pass = new String(password.getPassword());
            if (user.isEmpty() || pass.isEmpty()) {
                status.setText("Enter a username and password.");
            } else if (user.equals("demo") && pass.equals("secret")) {
                status.setText("Signed in as " + user + " (" + role.getSelectedItem() + ")"
                        + (remember.isSelected() ? ", remembered" : ""));
                JOptionPane.showMessageDialog(frame, "Welcome, " + user + "!", "Signed in",
                        JOptionPane.INFORMATION_MESSAGE);
            } else {
                status.setText("Invalid username or password.");
            }
        });

        JPanel panel = new JPanel(new GridBagLayout());
        panel.setBorder(BorderFactory.createEmptyBorder(12, 12, 12, 12));
        GridBagConstraints c = new GridBagConstraints();
        c.insets = new Insets(4, 4, 4, 4);
        c.anchor = GridBagConstraints.WEST;
        addRow(panel, c, 0, "Username", username);
        addRow(panel, c, 1, "Password", password);
        addRow(panel, c, 2, "Role", role);
        c.gridx = 1;
        c.gridy = 3;
        panel.add(remember, c);
        c.gridy = 4;
        panel.add(signIn, c);
        c.gridx = 0;
        c.gridy = 5;
        c.gridwidth = 2;
        panel.add(status, c);
        return panel;
    }

    /** The todos tab: add, remove, and clear items in a list. */
    private static JPanel todoPanel() {
        DefaultListModel<String> model = new DefaultListModel<>();
        JList<String> list = named(new JList<>(model), "todo-list", "Todos");
        JTextField input = named(new JTextField(20), "todo-input", "New todo");
        JButton add = named(new JButton("Add"), "todo-add", "Add");
        JButton remove = named(new JButton("Remove selected"), "todo-remove", "Remove selected");
        JButton clear = named(new JButton("Clear all"), "todo-clear", "Clear all");
        JLabel count = named(new JLabel("0 items"), "todo-count", "Item count");

        Runnable refreshCount = () -> count.setText(model.size() + (model.size() == 1 ? " item" : " items"));
        Runnable addTodo = () -> {
            String text = input.getText().trim();
            if (!text.isEmpty()) {
                model.addElement(text);
                input.setText("");
                refreshCount.run();
            }
        };
        add.addActionListener(e -> addTodo.run());
        input.addActionListener(e -> addTodo.run());
        remove.addActionListener(e -> {
            int index = list.getSelectedIndex();
            if (index >= 0) {
                model.remove(index);
                refreshCount.run();
            }
        });
        clear.addActionListener(e -> {
            model.clear();
            refreshCount.run();
        });

        JPanel top = new JPanel(new FlowLayout(FlowLayout.LEFT));
        top.add(input);
        top.add(add);

        JPanel bottom = new JPanel(new FlowLayout(FlowLayout.LEFT));
        bottom.add(remove);
        bottom.add(clear);
        bottom.add(count);

        JPanel panel = new JPanel(new BorderLayout());
        panel.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
        panel.add(top, BorderLayout.NORTH);
        panel.add(new JScrollPane(list), BorderLayout.CENTER);
        panel.add(bottom, BorderLayout.SOUTH);
        return panel;
    }

    /** Adds a labelled row whose label is bound to its field for accessibility. */
    private static void addRow(JPanel panel, GridBagConstraints c, int row, String text, JComponent field) {
        JLabel label = new JLabel(text);
        label.setLabelFor(field);
        c.gridx = 0;
        c.gridy = row;
        panel.add(label, c);
        c.gridx = 1;
        panel.add(field, c);
    }

    /** Gives a component a stable name for locators and an accessible name for the accessibility tree. */
    private static <T extends JComponent> T named(T component, String name, String accessibleName) {
        component.setName(name);
        component.getAccessibleContext().setAccessibleName(accessibleName);
        return component;
    }
}
