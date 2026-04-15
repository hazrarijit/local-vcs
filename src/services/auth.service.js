/**
 * auth.service.js - Local Authentication Service
 * 
 * Handles user registration, login, and session management.
 * Passwords are hashed with bcrypt. No server auth - fully local.
 */

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const JsonStore = require('../utils/store');

const SALT_ROUNDS = 10;

class AuthService {
    constructor() {
        this.store = new JsonStore('auth.json');
    }

    /**
     * Register a new user
     * @param {object} userData - { name, username, email, password }
     * @returns {object} - { success, message, user? }
     */
    async register({ name, username, email, password }) {
        // Validate inputs
        if (!name || !username || !email || !password) {
            return { success: false, message: 'All fields are required.' };
        }

        if (password.length < 6) {
            return { success: false, message: 'Password must be at least 6 characters.' };
        }

        // Check if username already exists
        const users = this.store.get('users', []);
        const exists = users.find(u => u.username === username || u.email === email);
        if (exists) {
            return { success: false, message: 'Username or email already registered.' };
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        const user = {
            id: uuidv4(),
            name,
            username,
            email,
            password: hashedPassword,
            createdAt: new Date().toISOString()
        };

        users.push(user);
        this.store.set('users', users);

        // Auto-login after registration
        const sessionUser = { ...user };
        delete sessionUser.password;
        this.store.set('session', sessionUser);

        return { success: true, message: 'Registration successful.', user: sessionUser };
    }

    /**
     * Login with username/email and password
     * @param {string} identifier - Username or email
     * @param {string} password
     * @returns {object} - { success, message, user? }
     */
    async login(identifier, password) {
        if (!identifier || !password) {
            return { success: false, message: 'Username/email and password are required.' };
        }

        const users = this.store.get('users', []);
        const user = users.find(u => u.username === identifier || u.email === identifier);

        if (!user) {
            return { success: false, message: 'Invalid credentials.' };
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return { success: false, message: 'Invalid credentials.' };
        }

        // Create session
        const sessionUser = { ...user };
        delete sessionUser.password;
        this.store.set('session', sessionUser);

        return { success: true, message: 'Login successful.', user: sessionUser };
    }

    /**
     * Get current session
     * @returns {object|null}
     */
    getSession() {
        return this.store.get('session', null);
    }

    /**
     * Logout - clear session
     */
    logout() {
        this.store.delete('session');
        return { success: true, message: 'Logged out.' };
    }

    /**
     * Check if any user is registered
     * @returns {boolean}
     */
    hasUsers() {
        const users = this.store.get('users', []);
        return users.length > 0;
    }

    /**
     * Update user profile
     * @param {string} userId
     * @param {object} updates - { name?, email? }
     * @returns {object}
     */
    updateProfile(userId, updates) {
        const users = this.store.get('users', []);
        const idx = users.findIndex(u => u.id === userId);
        if (idx === -1) {
            return { success: false, message: 'User not found.' };
        }

        if (updates.name) users[idx].name = updates.name;
        if (updates.email) users[idx].email = updates.email;

        this.store.set('users', users);

        // Update session if this is the current user
        const session = this.getSession();
        if (session && session.id === userId) {
            const sessionUser = { ...users[idx] };
            delete sessionUser.password;
            this.store.set('session', sessionUser);
        }

        return { success: true, message: 'Profile updated.' };
    }
}

module.exports = AuthService;
